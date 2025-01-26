FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

# Explicitly copy app.js
COPY app.js .

# List directory contents for debugging
RUN ls -la /app

# Install Mosquitto MQTT Broker (keep this part)
RUN apk add --no-cache mosquitto

COPY mosquitto/config /mosquitto/config

# Expose ports for both app and MQTT
EXPOSE 3000 1883

# Startup script to run both Node.js app and Mosquitto
CMD sh -c "mosquitto -c /mosquitto/config/mosquitto.conf & node app.js"