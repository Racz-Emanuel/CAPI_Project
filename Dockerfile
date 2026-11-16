# One image used by the API, the worker and the setup job.
# docker-compose.yml decides which file each container runs.
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
COPY public ./public
CMD ["node", "src/api.js"]
