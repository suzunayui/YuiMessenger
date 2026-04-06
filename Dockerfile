FROM docker.io/library/node:22-bookworm-slim

WORKDIR /app

COPY package.json ./

RUN npm install

COPY public ./public
COPY src ./src

ENV NODE_ENV=development
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "run", "dev"]
