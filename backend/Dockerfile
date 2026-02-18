FROM node:18-alpine
WORKDIR /app
COPY package.json package.json
# Use npm install when package-lock.json isn't present to avoid npm ci failure in build
RUN npm install --production
COPY index.js index.js
EXPOSE 3000
CMD ["node", "index.js"]
