const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const FormData = require('form-data');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Headers configuration
const headers = {
  'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Microsoft Edge";v="120"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'Referer': 'https://multimovies.press/',
  'Sec-Fetch-User': '?1',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0'
};

// Base URL
const BASE_URL = 'https://multimovies.press';

// Route to get movie/series info
app.get('/api/multimovies/info', async (req, res) => {
  try {
    const { link } = req.query;
    if (!link) {
      return res.status(400).json({ error: 'Missing link parameter' });
    }

    const url = link.startsWith(BASE_URL) ? link : `${BASE_URL}${link.startsWith('/') ? '' : '/'}${link}`;
    console.log('Fetching info from:', url);

    const response = await axios.get(url, { headers });
    const $ = cheerio.load(response.data);
    
    const type = url.includes('tvshows') ? 'series' : 'movie';
    const title = url.split('/')[4].replace(/-/g, ' ');
    const image = $('.g-item').find('a').attr('href') || '';
    const synopsis = $('.wp-content').find('p').text() || '';

    // Links
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

    res.json({
      title,
      synopsis,
      image,
      type,
      links
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      error: 'Internal server error',
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

    const ajaxUrl = `${BASE_URL}/wp-admin/admin-ajax.php`;
    console.log('Making AJAX request to:', ajaxUrl);

    const ajaxResponse = await axios.post(ajaxUrl, formData, {
      headers: {
        ...headers,
        ...formData.getHeaders()
      }
    });

    const playerData = ajaxResponse.data;
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

    // Extract stream URL from obfuscated JavaScript
    const functionRegex = /eval\(function\((.*?)\)\{.*?return p\}.*?\('(.*?)'\.split/;
    const match = functionRegex.exec(iframeHtml);
    let decodedScript = '';

    if (match) {
      const params = match[1].split(',').map(param => param.trim());
      const encodedString = match[2];
      let p = encodedString.split("',36,")?.[0].trim();
      const a = 36;
      const c = encodedString.split("',36,")[1].slice(2).split('|').length;
      const k = encodedString.split("',36,")[1].slice(2).split('|');

      for (let i = 0; i < c; i++) {
        if (k[i]) {
          const regex = new RegExp('\\b' + i.toString(a) + '\\b', 'g');
          p = p.replace(regex, k[i]);
        }
      }

      decodedScript = p;
    }

    // Extract stream URL and subtitles
    const streamUrl = decodedScript?.match(/file:\s*"([^"]+\.m3u8[^"]*)"/)?.[1];
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

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});