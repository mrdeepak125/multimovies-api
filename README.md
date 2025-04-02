# Multimovie API  

The multimovie API is a powerful tool for accessing movie and TV show details, download links, and streaming content. Below are the details of the API endpoints and their usage.  

## Base URL  
```
https://multimovie.vercel.app
```  

## Endpoints  

### 1. Movie Details and Download Link  
Retrieve information and download links for movies.  
**Endpoint:**  
```
/api/multimovies/info?link=movies/<movie-name>
```  
**Example:**  
```
/api/multimovies/info?link=movies/rrr
```  

### 2. Watch Movie (M3U8 Stream)  
Stream movies directly using the M3U8 format.  
**Endpoint:**  
```
/api/multimovies/stream?url=<movie-url>
```  
**Example:**  
```
/api/multimovies/stream?url=https://multimovies.press/movies/rrr
```  

### 3. TV Show Details and Download Link  
Retrieve information and download links for TV shows.  
**Endpoint:**  
```
/api/multimovies/info?link=tvshows/<tv-show-name>
```  
**Example:**  
```
/api/multimovies/info?link=tvshows/squid-game
```  

### 4. Watch TV Show Episode (M3U8 Stream)  
Stream TV show episodes directly using the M3U8 format.  
**Endpoint:**  
```
/api/multimovies/stream?url=<episode-url>
```  
**Example:**  
```
/api/multimovies/stream?url=https://multimovies.press/episodes/squid-game-1x1
```  

## Notes  
- Replace `<movie-name>` or `<tv-show-name>` with the desired movie or TV show name.  
- Replace `<movie-url>` or `<episode-url>` with the appropriate URL for the movie or episode.  

Enjoy seamless access to movies and TV shows with the multimovie API!  
