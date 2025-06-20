# Use an official Node.js runtime as a parent image
# Using Node.js 20 as it's a recent LTS version
FROM node:20-slim

# Set the working directory in the container
WORKDIR /usr/src/app

# Install system dependencies required for video processing
# - ffmpeg: for clipping and concatenating videos
# - ca-certificates: for making HTTPS requests to download yt-dlp
# - curl: to download yt-dlp
RUN apt-get update && apt-get install -y \
    ffmpeg \
    ca-certificates \
    curl \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Install yt-dlp (a youtube-dl fork) for downloading videos
# This is more reliable than installing via pip in a Node container
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Copy package.json and package-lock.json (if it exists)
COPY package*.json ./

# Install production dependencies. This is more flexible than `npm ci` as it
# will generate a lockfile if one doesn't exist.
RUN npm install --omit=dev

# Bundle app source
COPY . .

# Define the command to run your function
# The Functions Framework will start a server that listens for events
# The second argument is the name of the exported function to be executed
CMD ["npx", "@google-cloud/functions-framework", "--target=processVideoJob"]
