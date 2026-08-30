FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV NODE_ENV=production \
    PORT=8788 \
    HOST=0.0.0.0 \
    CODEX_AUTH_FILE=/auth-store/auth-profiles.json \
    REQUEST_TIMEOUT_MS=120000
EXPOSE 8788
CMD ["node", "src/server.mjs"]
