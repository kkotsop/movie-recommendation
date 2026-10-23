# SwipeFlick for a phone: one small always-on container.
#   docker build -t swipeflick .
#   docker run -p 8080:8080 -v swipeflick-data:/data -e TMDB_API_KEY=your-key swipeflick
# Put it behind HTTPS (any host that terminates TLS), then open the URL on your phone and "Add to Home Screen".
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY src ./src
COPY public ./public
COPY data/demo-catalog.json ./data/demo-catalog.json
ENV HOST=0.0.0.0 PORT=8080 HOSTED=1 SWIPEFLICK_DATA=/data NODE_ENV=production
RUN mkdir /data && chown node:node /data
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "server.js"]
