FROM node:24-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts

COPY . .
RUN npm run build
# The build needs the dev dependencies, and the image doesn't
RUN npm prune --omit=dev --ignore-scripts

FROM node:24-slim

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

ENV NODE_ENV=production

ENTRYPOINT ["node", "dist/index.js"]
