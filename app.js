const express = require('express');
const mqtt = require('mqtt');
const cors = require('cors');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const dotenv = require('dotenv').config();
const app = express();

app.use(express.json());
app.use(cors());

// MQTT Broker setup
const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://mosquitto';
const MQTT_PORT = process.env.MQTT_PORT || 1883;
const broker = mqtt.connect(`${MQTT_BROKER_URL}:${MQTT_PORT}`);
const TOPIC_LED = 'device/led';

// Google Gemini API setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-pro" });

// MQTT connection
broker.on('connect', () => {
    console.log('Connected to MQTT broker');
});

broker.on('error', (error) => {
    console.error('MQTT Broker Connection Error:', error);
});


// Calculate parameters for blinking LED
function calculateBlinkParams(delay, times, duration) {
    let calculatedDelay, calculatedTimes, calculatedDuration;

    if (duration !== undefined && times !== undefined) {
        calculatedDelay = duration / (times * 2); // Calculate delay based on duration and times
        calculatedTimes = times;
        calculatedDuration = duration;
    } else if (duration !== undefined) {
        calculatedDelay = 0.5; // Default delay if only duration is given
        calculatedTimes = 5;     // Default times
        calculatedDuration = duration;
    } else if (times !== undefined) {
        calculatedDelay = 0.5; // Default delay if only times given
        calculatedTimes = times;
        calculatedDuration = 5;     // Default duration
    } else {
        calculatedDelay = 0.5; // Default delay
        calculatedTimes = 5;     // Default times
        calculatedDuration = 5;     // Default duration
    }

    return { delay: calculatedDelay, times: calculatedTimes, duration: calculatedDuration };
}

async function processGeminiResponse(prompt) {
    const systemPrompt = `Your name is Sol. You are a helpful home automation assistant. When the user asks to control an LED, extract the desired state and parameters.

For LED control commands, respond in a structured way, ONLY providing a code block with parameters and a concise natural language confirmation.

- For turning ON the LED:
    - If a duration is mentioned in the user prompt, say "Turning LED ON for <duration> seconds" and ONLY include the following code block in your response: \`\`\`action:control,device:led,state:ON,duration=<seconds>\`\`\`.
    - If NO duration is mentioned, just say "Turning LED ON" and ONLY include the following code block: \`\`\`action:control,device:led,state:ON\`\`\`.

- For turning OFF the LED:
    - Say "Turning LED OFF" and ONLY include this code block: \`\`\`action:control,device:led,state:OFF\`\`\`.

- For blinking the LED:
    - If delay, times, AND duration are ALL explicitly mentioned in the user prompt, acknowledge them in your natural language response (e.g., "Blinking LED with delay <delay>s, <times> times, for <duration>s"). Then, ONLY include the following code block with the parameters from the user prompt: \`\`\`action:control,device:led,state:BLINK,delay=<seconds>,times=<number>,duration=<seconds>\`\`\`.
    - If ONLY duration and times are mentioned, use the calculated delay based on duration and times. Acknowledge the duration and times in your response (e.g., "Blinking LED for <duration> seconds, <times> times").  Then, ONLY include the code block with calculated parameters: \`\`\`action:control,device:led,state:BLINK,delay=<calculated_delay>,times=<times>,duration=<duration>\`\`\`.
    - If ONLY duration is mentioned, use default times (5) and calculate delay. Acknowledge the duration and default times in your response (e.g., "Blinking LED for <duration> seconds, using default 5 times"). Include code block with calculated parameters.
    - If ONLY times is mentioned, use default duration (5s) and calculate delay. Acknowledge the times and default duration. Include code block with calculated parameters.
    - If NEITHER duration NOR times are mentioned, use default duration (5s) and default times (5) and default delay (0.5s). Say "Blinking LED using default parameters". Include code block with default parameters.

For questions or other requests NOT related to LED control, respond naturally as a chatbot WITHOUT any code blocks.`;

    const chat = model.startChat({ history: [ { role: "user", parts: [{ text: systemPrompt }], }, ], });
    try {
        const result = await chat.sendMessage(prompt);
        const response = result.response.text();
        console.log("Gemini Response:", response);

        let state = null;
        let params = {};
        let isControlCommand = false;

        const codeBlockMatch = response.match(/```(.*?)```/s);
        let codeBlockContent = codeBlockMatch ? codeBlockMatch[1].trim() : null;

        if (codeBlockContent) {
            const keyValuePairs = codeBlockContent.split(',').map(pair => pair.trim());
            const action = keyValuePairs.find(pair => pair.startsWith('action:'))?.split(':')[1];
            const device = keyValuePairs.find(pair => pair.startsWith('device:'))?.split(':')[1];
            state = keyValuePairs.find(pair => pair.startsWith('state:'))?.split(':')[1];

            if (action === 'control' && device === 'led' && state) {
                isControlCommand = true;
                let delay, times, duration; // Declare variables to capture from Gemini response

                keyValuePairs.forEach(pair => {
                    if (pair.startsWith('duration:')) duration = parseFloat(pair.split(':')[1]);
                    if (pair.startsWith('delay:')) delay = parseFloat(pair.split(':')[1]);
                    if (pair.startsWith('times:')) times = parseInt(pair.split(':')[1]);
                });

                if (state === 'BLINK') {
                    params = calculateBlinkParams(delay, times, duration); // Use calculateBlinkParams for blink parameters
                } else if (state === 'ON') {
                    params = {}; // Initialize params object for ON state
                    if (duration !== undefined) params.duration = duration; // Now, *add* duration if present
                }
            }
        }

        if (isControlCommand) {
            return { type: 'control', state, params, response };
        } else {
            return { type: 'chat', response };
        }

    } catch (error) {
        console.error("Gemini API Error:", error);
        return { type: 'error', response: "Failed to get response from AI model." };
    }
}


// API Endpoints
app.post('/prompt', async (req, res) => {
    const { prompt } = req.body;

    if (!prompt) {
        return res.status(400).json({ error: 'Prompt is required' });
    }
    try {
        const geminiResponse = await processGeminiResponse(prompt);

        if (geminiResponse.type === 'control' && geminiResponse.state) {
            console.log("Gemini Response Object before MQTT Publish:", geminiResponse);
            const mqttPayload = JSON.stringify({ state: geminiResponse.state, params: geminiResponse.params });
            console.log("MQTT Payload being published:", mqttPayload);
            broker.publish(TOPIC_LED, mqttPayload)
            res.json({ success: true, message: "Message sent to device", response: geminiResponse.response})
        } else if (geminiResponse.type === 'chat') {
             res.json({ success: true, message:"Chat response.", response: geminiResponse.response});
        } else if (geminiResponse.type === 'error') {
            res.status(500).json({ success: false, message: "AI processing error", response: geminiResponse.response });
        }
    } catch (e) {
        console.error("Error processing prompt:", e);
        res.status(500).json({ error: 'Error processing prompt', details: e.message });
    }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});