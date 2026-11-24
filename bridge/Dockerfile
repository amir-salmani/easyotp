# Bridge 1: the Node build of the bridge, for a host that gives it very little.
# It runs as an unprivileged user on a read-only root, listens on one port and
# writes only under DATA_DIR. The contract is in docs/BRIDGES.md.
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY src ./src
# The signed files a Host fetches (DECISIONS D32), bundled into the server.
COPY dist-files ./dist-files
RUN npm run build:node

FROM node:22-alpine
ENV NODE_ENV=production HOST=127.0.0.1 PORT=8080 DATA_DIR=/data
COPY --from=build /src/dist/node.mjs /app/node.mjs
USER 10001:10001
EXPOSE 8080
CMD ["node", "/app/node.mjs"]
