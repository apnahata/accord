FROM node:22-bookworm-slim
WORKDIR /app
COPY . .
RUN npm ci && npm run build
ENV NODE_ENV=production PORT=3000
USER node
EXPOSE 3000
CMD ["npm", "run", "dev:api"]
