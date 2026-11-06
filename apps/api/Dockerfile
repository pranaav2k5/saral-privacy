# Build context is the repository root:
#   docker build -f apps/api/Dockerfile -t saral-api:dev .
FROM node:24-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS build
RUN npm install --global pnpm@11.0.9
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter "@saral/api..." --filter "saral-privacy"
# "@saral/api..." is the API and every workspace package it depends on, built in dependency order.
RUN pnpm --filter "@saral/api..." run build \
 && pnpm --filter @saral/api deploy --legacy --prod /out

FROM node:24-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
ENV NODE_ENV=production
# npm and corepack are not needed at runtime; removing them drops their bundled dependencies from the image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
 /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
COPY --from=build /out ./
USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]
