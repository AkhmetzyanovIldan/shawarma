FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY config ./config
COPY public ./public
COPY scripts ./scripts
RUN mkdir -p /app/data /var/data && chown node:node /app/data /var/data
# Mounted disks can replace the ownership set during the image build.
# Bootstrap the data directory, then drop privileges before loading the server.
USER root
ENV NODE_ENV=production DATA_DIR=/var/data PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/container-entrypoint.mjs"]
