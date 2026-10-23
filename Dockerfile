# SwipeFlick for a phone: one small always-on container.
#   docker build -t swipeflick .
#   docker run -p 8080:8080 -v swipeflick-data:/data -e ACCESS_TOKEN=choose-a-long-code swipeflick
# Put it behind HTTPS (any host that terminates TLS), then open the URL on your phone and "Add to Home Screen".
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
# Playwright (the desktop "Log in with Netflix" window) is optional and not needed here.
RUN npm ci --omit=dev --omit=optional
COPY server.js ./
COPY src ./src
COPY public ./public
COPY data/demo-catalog.json ./data/demo-catalog.json
ENV HOST=0.0.0.0 PORT=8080 SWIPEFLICK_DATA=/data NODE_ENV=production
RUN mkdir /data && chown node:node /data
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "server.js"]
