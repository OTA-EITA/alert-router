# Build: bundle the service into a single file. The bundle is plain JavaScript,
# so this stage runs on the build machine's platform even for multi-arch images.
FROM --platform=$BUILDPLATFORM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
WORKDIR /src
COPY package.json package-lock.json ./
# Dependencies' install scripts never run.
RUN npm ci --ignore-scripts
COPY tsconfig.json build.mjs ./
COPY src ./src
RUN npm run build

# Run: distroless (no shell, no package manager) as a non-root user.
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:78f07ef1b5ea71ad7c055df15d0dd8997f2d288f9158623c4d4ae3d765b7d50d
COPY --from=build /src/dist/server.js /app/server.js
USER nonroot
EXPOSE 9095
ENTRYPOINT ["/nodejs/bin/node", "/app/server.js"]
CMD ["serve", "--config", "/etc/alert-router/config.yaml"]
