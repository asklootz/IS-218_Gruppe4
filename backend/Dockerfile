FROM node:18-alpine

# Install Python and pip for Overture Maps data download
RUN apk add --no-cache python3 py3-pip

WORKDIR /app

COPY package*.json ./

RUN npm install

# Install Python packages (using --break-system-packages for Alpine compatibility)
RUN pip3 install --no-cache-dir --break-system-packages overturemaps

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
