# Build: bundle the service into a single file. The bundle is plain JavaScript,
# so this stage runs on the build machine's platform even for multi-arch images.
FROM --platform=$BUILDPLATFORM node:24-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
WORKDIR /src
COPY package.json package-lock.json ./
# Dependencies' install scripts never run.
RUN npm ci --ignore-scripts
COPY tsconfig.json build.mjs ./
COPY src ./src
RUN npm run build

# Run: distroless (no shell, no package manager) as a non-root user.
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:a6c34457f6da4295807e051411c7783739c65b997a324fed14e4fa292615ae91
COPY --from=build /src/dist/server.js /app/server.js
USER nonroot
EXPOSE 9095
ENTRYPOINT ["/nodejs/bin/node", "/app/server.js"]
CMD ["serve", "--config", "/etc/alert-router/config.yaml"]
