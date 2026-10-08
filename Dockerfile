FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    AI_GATEWAY_CONFIG=/data/config.yaml \
    AI_GATEWAY_DB=/data/usage.sqlite3

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY config/container.example.yaml ./config/container.example.yaml
COPY docker/entrypoint.sh /usr/local/bin/ai-gateway-entrypoint
RUN chmod 0755 /usr/local/bin/ai-gateway-entrypoint \
    && mkdir -p /data \
    && chown node:node /data

USER node
EXPOSE 4000
ENTRYPOINT ["ai-gateway-entrypoint"]
