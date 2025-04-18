const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const FormData = require('form-data');
const NodeCache = require('node-cache');

// Correct axios-retry import
const axiosRetry = require('axios-retry').default;

const app = express();
const PORT = process.env.PORT || 3000;
const cache = new NodeCache({ stdTTL: 60 * 15 }); // 15 minute cache

// Configure axios with longer timeouts and retries
axiosRetry(axios, {
  retries: 3,
  retryDelay: (retryCount) => {
    return retryCount * 2000; // 2s, 4s, then 6s delay between retries
  },
  retryCondition: (error) => {
    return axiosRetry.isNetworkError(error) || 
           axiosRetry.isRetryableError(error) ||
           error.code === 'ECONNABORTED';
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

// Headers configuration
const headers = {
  'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Microsoft Edge";v="120"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'Referer': 'https://multimovies.cloud/',
  'Sec-Fetch-User': '?1',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0'
};

const BASE_URL = 'https://multimovies.guru';

// Helper function for axios requests with better error handling
async function fetchWithRetry(url, options = {}, retries = 2) {
  const axiosConfig = {
    ...options,
    headers: { ...headers, ...options.headers },
    timeout: 10000 // 10 seconds timeout
  };

  try {
    const response = await axios.get(url, axiosConfig);
    return response;
  } catch (error) {
    if (retries > 0) {
      console.log(`Retrying ${url}, attempts left: ${retries}`);
      await new Promise(resolve => setTimeout(resolve, 2000));
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
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Route to get stream data
app.get('/api/multimovies/stream', async (req, res) => {
  try {
    const { url, type } = req.query;
    if (!url) {
      return res.status(400).json({ error: 'Missing url parameter' });
    }

    console.log('Fetching stream from:', url);

    const response = await axios.get(url, { headers });
    const $ = cheerio.load(response.data);

    const postId = $('#player-option-1').attr('data-post');
    const nume = $('#player-option-1').attr('data-nume');
    const typeValue = $('#player-option-1').attr('data-type');

    if (!postId || !nume || !typeValue) {
      return res.status(404).json({ error: 'Player data not found' });
    }

    const formData = new FormData();
    formData.append('action', 'doo_player_ajax');
    formData.append('post', postId);
    formData.append('nume', nume);
    formData.append('type', typeValue);

    const baseUrl = new URL(url).origin;
    const ajaxUrl = `${baseUrl}/wp-admin/admin-ajax.php`;
    console.log('Making AJAX request to:', ajaxUrl);

    const playerRes = await axios.post(ajaxUrl, formData, {
      headers: {
        ...headers,
        ...formData.getHeaders()
      }
    });

    const playerData = playerRes.data;
    let iframeUrl = playerData?.embed_url?.match(/<iframe[^>]+src="([^"]+)"[^>]*>/i)?.[1] || playerData?.embed_url;

    if (!iframeUrl) {
      return res.status(404).json({ error: 'No iframe URL found' });
    }

    console.log('Iframe URL:', iframeUrl);

    // Handle external iframe URLs
    if (!iframeUrl.includes('multimovies')) {
      let playerBaseUrl = new URL(iframeUrl).origin;
      
      try {
        // Check for redirects
        const headResponse = await axios.head(playerBaseUrl, { headers });
        if (headResponse.request?.res?.responseUrl) {
          playerBaseUrl = new URL(headResponse.request.res.responseUrl).origin;
        }
      } catch (e) {
        console.log('Could not check for redirects:', e.message);
      }

      const playerId = iframeUrl.split('/').pop();
      const embedFormData = new FormData();
      embedFormData.append('sid', playerId);

      const embedHelperUrl = `${playerBaseUrl}/embedhelper.php`;
      console.log('Making embed helper request to:', embedHelperUrl);

      try {
        const embedResponse = await axios.post(embedHelperUrl, embedFormData, {
          headers: {
            ...headers,
            ...embedFormData.getHeaders()
          }
        });

        const embedData = embedResponse.data;
        const siteUrl = embedData?.siteUrls?.smwh;
        let siteId;
        
        try {
          siteId = JSON.parse(Buffer.from(embedData?.mresult, 'base64').toString())?.smwh;
        } catch (e) {
          siteId = embedData?.mresult?.smwh;
        }

        if (siteUrl && siteId) {
          iframeUrl = siteUrl + siteId;
          console.log('New iframe URL:', iframeUrl);
        }
      } catch (e) {
        console.log('Embed helper failed:', e.message);
      }
    }

    // Fetch iframe content
    const iframeResponse = await axios.get(iframeUrl, { headers });
    const iframeHtml = iframeResponse.data;

    // Extract the function parameters and the encoded string
    const functionRegex = /eval\(function\((.*?)\)\{.*?return p\}.*?\('(.*?)'\.split/;
    const match = functionRegex.exec(iframeHtml);
    let decodedScript = '';

    if (match) {
      const params = match[1].split(',').map(param => param.trim());
      const encodedString = match[2];

      decodedScript = encodedString.split("',36,")?.[0].trim();
      const a = 36;
      const c = encodedString.split("',36,")[1].slice(2).split('|').length;
      const k = encodedString.split("',36,")[1].slice(2).split('|');

      for (let i = 0; i < c; i++) {
        if (k[i]) {
          const regex = new RegExp('\\b' + i.toString(a) + '\\b', 'g');
          decodedScript = decodedScript.replace(regex, k[i]);
        }
      }
    }

    // Extract stream URL and subtitles
    const streamUrl = decodedScript?.match(/https?:\/\/[^"]+?\.m3u8[^"]*/)?.[0];
    const subtitles = [];
    const subtitleMatches = decodedScript?.match(/https:\/\/[^\s"]+\.vtt/g) || [];

    subtitleMatches.forEach(sub => {
      const langMatch = sub.match(/_([a-zA-Z]{3})\.vtt$/);
      if (langMatch) {
        subtitles.push({
          language: langMatch[1],
          uri: sub,
          type: 'VTT',
          title: langMatch[1]
        });
      }
    });

    if (!streamUrl) {
      return res.status(404).json({ error: 'No stream URL found' });
    }

    // Clean up stream URL
    const cleanStreamUrl = streamUrl.replace(/&i=\d+,'\.4&/, '&i=0.4&');

    res.json([{
      server: 'MultiMovies',
      link: cleanStreamUrl,
      type: 'm3u8',
      subtitles,
      headers: {
        Referer: iframeUrl,
        Origin: new URL(iframeUrl).origin,
        'User-Agent': headers['User-Agent']
      }
    }]);

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
