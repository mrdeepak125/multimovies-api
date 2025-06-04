const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const FormData = require('form-data');
const NodeCache = require('node-cache');
const axiosRetry = require('axios-retry').default;

const app = express();
const PORT = process.env.PORT || 3000;
const cache = new NodeCache({ stdTTL: 60 * 15 }); // 15 minute cache


class Scraper {
  constructor(client, mainUrl) {
    this.client = client;
    this.mainUrl = mainUrl;
    this.headers = {
      'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Microsoft Edge";v="120"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'Referer': mainUrl,
      'Sec-Fetch-User': '?1',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Cache-Control': 'max-age=0'
    };
  }

  async getEmbed(postId, nume, referUrl) {
    try {
      console.log(`Getting embed for postId: ${postId}, nume: ${nume}`);
      const formData = new FormData();
      formData.append('action', 'doo_player_ajax');
      formData.append('post', postId);
      formData.append('nume', nume);
      formData.append('type', 'movie');

      const response = await this.client.post(
        `${this.mainUrl}/wp-admin/admin-ajax.php`,
        formData,
        {
          headers: {
            ...formData.getHeaders(),
            'Referer': referUrl || this.mainUrl,
            'X-Requested-With': 'XMLHttpRequest'
          },
          timeout: 15000
        }
      );

      console.log('Embed response:', JSON.stringify(response.data, null, 2));

      if (!response.data) {
        console.error('No data in embed response');
        return null;
      }

      // Try different response formats
      let embedUrl = null;
      if (typeof response.data === 'string') {
        // If response is a string, try to parse it as JSON
        try {
          const parsed = JSON.parse(response.data);
          embedUrl = parsed.embed_url;
        } catch (e) {
          // If not JSON, try to extract URL directly
          const urlMatch = response.data.match(/"([^"]+\.(?:mp4|m3u8|mkv)[^"]*)"/);
          if (urlMatch) {
            embedUrl = urlMatch[1];
          }
        }
      } else if (response.data.embed_url) {
        embedUrl = response.data.embed_url;
      }

      if (embedUrl) {
        console.log('Found embed URL:', embedUrl);
        return { embed_url: embedUrl };
      } else {
        console.error('Could not find embed URL in response');
        return null;
      }
    } catch (error) {
      console.error('Error getting embed:', error.message);
      if (error.response) {
        console.error('Response status:', error.response.status);
        console.error('Response data:', error.response.data);
      }
      return null;
    }
  }

  async loadLinks(url) {
    try {
      console.log(`Loading video sources from: ${url}`);
      const response = await this.client.get(url, {
        headers: this.headers,
        timeout: 30000
      });
      
      const $ = cheerio.load(response.data);
      
      const sources = [];
      // First try to find player options
      const playerOptions = $('ul#playeroptionsul li').map((i, el) => ({
        postId: $(el).attr('data-post'),
        nume: $(el).attr('data-nume'),
        type: $(el).attr('data-type')
      })).get();

      console.log(`Found ${playerOptions.length} player options:`, JSON.stringify(playerOptions, null, 2));

      // If no player options found, try alternative selectors
      if (playerOptions.length === 0) {
        // Try to find iframe sources
        const iframes = $('iframe').map((i, el) => $(el).attr('src')).get();
        console.log(`Found ${iframes.length} iframe sources:`, iframes);
        sources.push(...iframes.filter(src => src && !src.includes('youtube')));

        // Try to find video sources in scripts
        const scripts = $('script').map((i, el) => $(el).html()).get();
        for (const script of scripts) {
          if (script) {
            // Look for common video source patterns
            const sourceMatches = script.match(/(?:source|file|src):\s*["']([^"']+)["']/g);
            if (sourceMatches) {
              const extractedSources = sourceMatches.map(match => {
                const source = match.match(/["']([^"']+)["']/)[1];
                return source;
              });
              sources.push(...extractedSources.filter(src => !src.includes('youtube')));
            }
          }
        }
      } else {
        // Process player options
        for (const option of playerOptions) {
          if (!option.nume.includes('trailer')) {
            console.log(`Processing player option: ${option.nume}`);
            const embedData = await this.getEmbed(option.postId, option.nume, url);
            if (embedData?.embed_url) {
              const link = embedData.embed_url;
              console.log('Extracted link:', link);
              
              if (link && !link.includes('youtube')) {
                if (link.includes('deaddrive.xyz')) {
                  console.log(`Processing deaddrive link: ${link}`);
                  const serverResponse = await this.client.get(link, {
                    headers: this.headers,
                    timeout: 15000
                  });
                  const server$ = cheerio.load(serverResponse.data);
                  const serverLinks = server$('ul.list-server-items > li')
                    .map((i, el) => server$(el).attr('data-video'))
                    .get();
                  console.log('Found server links:', serverLinks);
                  sources.push(...serverLinks);
                } else if (link.includes('gdmirrorbot.nl')) {
                  // Update the domain in the link
                  const newLink = link.replace('gdmirrorbot.nl', 'ssn.techinmind.space');
                  console.log(`Processing mirror link: ${newLink}`);
                  try {
                    // Extract the video ID from the URL
                    const videoId = newLink.split('/').pop();
                    console.log('Video ID:', videoId);

                    // First get the embed page to get any necessary cookies/tokens
                    const mirrorResponse = await this.client.get(newLink, {
                      headers: {
                        ...this.headers,
                        'Referer': url,
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.5',
                        'Connection': 'keep-alive',
                        'Upgrade-Insecure-Requests': '1'
                      },
                      timeout: 15000
                    });

                    // Try their actual API endpoint
                    const formData = new URLSearchParams();
                    formData.append('sid', videoId);
                    formData.append('UserFavSite', '');
                    formData.append('currentDomain', 'ssn.techinmind.space');

                    const dataResponse = await this.client.post(
                      'https://ssn.techinmind.space/embedhelper.php',
                      formData,
                      {
                        headers: {
                          ...this.headers,
                          'Referer': newLink,
                          'Accept': 'application/json',
                          'Content-Type': 'application/x-www-form-urlencoded',
                          'X-Requested-With': 'XMLHttpRequest',
                          'Origin': 'https://ssn.techinmind.space'
                        },
                        timeout: 15000
                      }
                    );

                    console.log('Data Response:', JSON.stringify(dataResponse.data, null, 2));

                    if (dataResponse.data && dataResponse.data.sources) {
                      // Process each source
                      for (const [siteKey, sourceData] of Object.entries(dataResponse.data.sources)) {
                        if (sourceData.encryptedValue && dataResponse.data.siteUrls[siteKey]) {
                          // Get the base URL for this site
                          const baseUrl = dataResponse.data.siteUrls[siteKey];
                          
                          // Get the encrypted value and site name
                          const encryptedValue = sourceData.encryptedValue.split('::')[0];
                          const encryptedSiteName = sourceData.encryptedSiteName.split('::')[0];
                          
                          // Get the decrypted value from mresult
                          const mresult = JSON.parse(atob(dataResponse.data.mresult));
                          const decryptedValue = mresult[siteKey];
                          
                          if (decryptedValue) {
                            // Construct the video URL
                            let videoUrl;
                            if (baseUrl.includes('#')) {
                              videoUrl = `${baseUrl}${decryptedValue}`;
                            } else {
                              videoUrl = `${baseUrl}${decryptedValue}`;
                            }
                            
                            console.log(`Found video URL for ${siteKey}: ${videoUrl}`);
                            
                            if (videoUrl && !videoUrl.includes('youtube')) {
                              sources.push(videoUrl);
                            }
                          }
                        }
                      }
                    }

                    // If still no sources, try to extract from the embed page
                    if (sources.length === 0) {
                      const $ = cheerio.load(mirrorResponse.data);
                      const scripts = $('script').map((i, el) => $(el).html()).get();
                      
                      for (const script of scripts) {
                        if (script) {
                          const sourceMatches = script.match(/(?:source|file|src):\s*["']([^"']+)["']/g);
                          if (sourceMatches) {
                            const extractedSources = sourceMatches.map(match => {
                              const source = match.match(/["']([^"']+)["']/)[1];
                              return source;
                            });
                            sources.push(...extractedSources.filter(src => 
                              src && 
                              !src.includes('youtube') && 
                              (src.endsWith('.mp4') || src.endsWith('.m3u8') || src.endsWith('.mkv'))
                            ));
                          }
                        }
                      }
                    }

                  } catch (error) {
                    console.error('Error processing mirror link:', error.message);
                    if (error.response) {
                      console.error('Error response status:', error.response.status);
                      console.error('Error response headers:', error.response.headers);
                      console.error('Error response data:', error.response.data);
                    }
                  }
                } else {
                  sources.push(link);
                }
              }
            }
          }
        }
      }

      // Filter and clean up sources
      const uniqueSources = [...new Set(sources)]
        .filter(src => src && src.trim() && !src.includes('youtube'))
        .map(src => src.trim());

      console.log(`Found ${uniqueSources.length} unique video sources:`, uniqueSources);
      return uniqueSources;
    } catch (error) {
      console.error('Error loading links:', error.message);
      if (error.response) {
        console.error('Response status:', error.response.status);
        console.error('Response headers:', error.response.headers);
        console.error('Response data:', error.response.data);
      }
      return [];
    }
  }
}

// Configure axios with longer timeouts and retries
axiosRetry(axios, {
  retries: 3,
  retryDelay: (retryCount) => {
    return retryCount * 2000; // 2s, 4s, then 6s delay between retries
  },
  retryCondition: (error) => {
    return axiosRetry.isNetworkError(error) || 
           axiosRetry.isRetryableError(error) ||
           error.code === 'ECONNABORTED' ||
           error.code === 'ECONNRESET';
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).send('OK - Server is running');
});

// Home route
app.get('/', (req, res) => {
  res.status(200).send('Welcome to the MultiMovies API! <br />Please use /api/multimovies/info or /api/multimovies/stream endpoints to fetch data.<br />More detail visit Github:-https://github.com/mrdeepak125/multimovies-api<br />Check server status:- /health');
});

// Headers configuration - updated to look more like a browser
const headers = {
   'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Microsoft Edge";v="120"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'Referer': 'https://multimovies.cfd',
            'Sec-Fetch-User': '?1',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Cache-Control': 'max-age=0'
};

const BASE_URL = 'https://multimovies.cfd';
const scraper = new Scraper(axios, BASE_URL);

// Improved fetchWithRetry function
async function fetchWithRetry(url, options = {}, retries = 3) {
  const axiosConfig = {
    ...options,
    headers: { ...headers, ...options.headers },
    timeout: 15000, // 15 seconds timeout
    validateStatus: function (status) {
      return status >= 200 && status < 500; // Don't throw for 404, etc.
    }
  };

  try {
    const response = await axios.get(url, axiosConfig);
    
    // Check if we got a valid HTML response
    if (response.status === 200 && response.data && response.data.includes('<!DOCTYPE html>')) {
      return response;
    }
    
    // If we got a non-200 status or non-HTML content, throw to trigger retry
    throw new Error(`Invalid response: Status ${response.status} or non-HTML content`);
    
  } catch (error) {
    if (retries > 0) {
      console.log(`Retrying ${url}, attempts left: ${retries}`);
      await new Promise(resolve => setTimeout(resolve, 2000 * (4 - retries))); // Exponential backoff
      return fetchWithRetry(url, options, retries - 1);
    }
    throw error;
  }
}

// Route to get movie/series info
app.get('/api/multimovies/info', async (req, res) => {
  try {
    const { link } = req.query;
    if (!link) {
      return res.status(400).json({ error: 'Missing link parameter' });
    }

    const url = link.startsWith(BASE_URL) ? link : `${BASE_URL}${link.startsWith('/') ? '' : '/'}${link}`;
    const cacheKey = `info:${url}`;
    
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
      return res.json(cachedData);
    }

    const response = await fetchWithRetry(url);
    const $ = cheerio.load(response.data);
    
    const type = url.includes('tvshows') ? 'series' : 'movie';
    const title = url.split('/')[4].replace(/-/g, ' ');
    const image = $('.g-item').find('a').attr('href') || '';
    const synopsis = $('.wp-content').find('p').text() || '';

    const links = [];

    if (type === 'series') {
      $('#seasons').children().each((i, element) => {
        const seasonTitle = $(element).find('.title').children().remove().end().text().trim();
        const episodes = [];
        
        $(element).find('.episodios').children().each((i, episode) => {
          const epNumber = $(episode).find('.numerando').text().trim().split('-')[1];
          const epTitle = `Episode ${epNumber}`;
          const epLink = $(episode).find('a').attr('href');
          
          if (epTitle && epLink) {
            episodes.push({
              title: epTitle,
              link: epLink
            });
          }
        });

        if (seasonTitle && episodes.length > 0) {
          links.push({
            title: seasonTitle,
            episodes: episodes
          });
        }
      });
    } else {
      links.push({
        title: title,
        link: url
      });
    }

    const responseData = {
      title,
      synopsis,
      image,
      type,
      links
    };

    cache.set(cacheKey, responseData);
    res.json(responseData);

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      error: 'Failed to fetch movie info',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      suggestion: 'The website might be blocking our requests. Try again later.'
    });
  }
});

// Stream route with improved error handling
// app.get('/api/multimovies/stream', async (req, res) => {
//   try {
//     const { url } = req.query;
//     if (!url) {
//       return res.status(400).json({ error: 'Missing url parameter' });
//     }

//     console.log('Fetching stream from:', url);

//     // First try to get the page content
//     let response;
//     try {
//       response = await fetchWithRetry(url);
//     } catch (error) {
//       console.error('Failed to fetch initial page:', error.message);
//       return res.status(502).json({
//         error: 'Could not connect to the source website',
//         details: process.env.NODE_ENV === 'development' ? error.message : undefined,
//         suggestion: 'The website might be temporarily unavailable. Try again later.'
//       });
//     }

//     const $ = cheerio.load(response.data);
    
//     // Try to extract player data
//     const playerOption = $('#player-option-1');
//     if (!playerOption.length) {
//       return res.status(404).json({ 
//         error: 'Player data not found in page',
//         suggestion: 'The page structure might have changed or the content is not available.'
//       });
//     }

//     const postId = playerOption.attr('data-post');
//     const nume = playerOption.attr('data-nume');
//     const typeValue = playerOption.attr('data-type');

//     if (!postId || !nume || !typeValue) {
//       return res.status(404).json({ 
//         error: 'Required player attributes not found',
//         details: { postId, nume, typeValue }
//       });
//     }

//     const baseUrl = new URL(url).origin;
//     console.log('Base URL:', baseUrl);

//     // Prepare AJAX request
//     const formData = new FormData();
//     formData.append('action', 'doo_player_ajax');
//     formData.append('post', postId);
//     formData.append('nume', nume);
//     formData.append('type', typeValue);

//     let playerRes;
//     console.log('Sending AJAX request to fetch player data...');
//     console.log('Form data:', formData.getBuffer().toString());
//     console.log('Form headers:', formData);
//     console.log('player', playerRes)
//     try {
//       playerRes = await axios.post(`${baseUrl}/wp-admin/admin-ajax.php`, formData, {
//         headers: {
//           ...headers,
//           ...formData.getHeaders(),
//           'Referer': url,
//           'Origin': baseUrl,
//           'Content-Type': `multipart/form-data; boundary=${formData.getBoundary()}`
//         },
//         timeout: 20000 // 20 seconds for this request
//       });
//     } catch (error) {
//       console.error('Player AJAX request failed:', error.message);
//       return res.status(502).json({
//         error: 'Failed to fetch player data',
//         details: process.env.NODE_ENV === 'development' ? error.message : undefined,
//         suggestion: 'The website might be blocking our requests. Try again later.'
//       });
//     }
    
//     const playerData = playerRes.data;
//     console.log('Player data:', playerRes);
    
//     // Try to extract iframe URL
//     let iframeUrl;
//     try {
//       if (typeof playerData === 'object' && playerData.embed_url) {
//         iframeUrl = playerData.embed_url;
//       } else if (typeof playerData === 'string') {
//         // Try to parse as JSON if it's a string
//         try {
//           const parsedData = JSON.parse(playerData);
//           iframeUrl = parsedData.embed_url;
//         } catch (e) {
//           // If not JSON, try to extract URL from string
//           const urlMatch = playerData.match(/https?:\/\/[^\s"']+/);
//           iframeUrl = urlMatch ? urlMatch[0] : null;
//         }
//       }
//     } catch (e) {
//       console.error('Error parsing player data:', e.message);
//     }

//     if (!iframeUrl) {
//       return res.status(404).json({
//         error: 'Could not extract embed URL from player data',
//         playerData: playerData,
//         suggestion: 'The website might have changed its API response format.'
//       });
//     }

//     // Return the iframe URL as fallback
//     res.json([{
//       server: 'MultiMovies',
//       link: iframeUrl,
//       type: 'iframe',
//       message: 'Direct stream extraction failed, but here is the embed URL you can use'
//     }]);

//   } catch (error) {
//     console.error('Unexpected error in stream endpoint:', error);
//     res.status(500).json({
//       error: 'Internal server error',
//       details: process.env.NODE_ENV === 'development' ? error.message : undefined,
//       suggestion: 'Please try again later or contact support if the problem persists.'
//     });
//   }
// });

// Stream route with improved scraping
app.get('/api/multimovies/stream', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) {
      return res.status(400).json({ error: 'Missing url parameter' });
    }

    const cacheKey = `stream:${url}`;
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
      return res.json(cachedData);
    }

    console.log('Fetching stream from:', url);

    // Use the scraper to get all available sources
    const sources = await scraper.loadLinks(url);
    
    if (!sources || sources.length === 0) {
      return res.status(404).json({ 
        error: 'No video sources found',
        suggestion: 'The content might not be available or the page structure has changed.'
      });
    }

    // Format the response
    const formattedSources = sources.map(source => ({
      server: 'MultiMovies',
      link: source,
      type: source.includes('.m3u8') ? 'hls' : 
            source.includes('.mpd') ? 'dash' : 
            source.includes('.mp4') ? 'direct' : 'iframe'
    }));

    // Cache the result
    cache.set(cacheKey, formattedSources);
    res.json(formattedSources);

  } catch (error) {
    console.error('Unexpected error in stream endpoint:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      suggestion: 'Please try again later or contact support if the problem persists.'
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ 
    error: 'Something went wrong!',
    details: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
