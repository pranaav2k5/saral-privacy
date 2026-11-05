# Build context is the repository root:
#   docker build -f apps/api/Dockerfile -t saral-api:dev .
FROM node:24-slim AS build
RUN npm install --global pnpm@11.0.9
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter "@saral/api..." --filter "saral-privacy"
RUN pnpm --filter @saral/api run build \
 && pnpm --filter @saral/api deploy --legacy --prod /out

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]
