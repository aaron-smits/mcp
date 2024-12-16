import http from 'node:http';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
const NWS_API_BASE = "https://api.weather.gov";
const USER_AGENT = "weather-app/1.0";
// Helper function for making NWS API requests
async function makeNWSRequest(url) {
    const headers = {
        "User-Agent": USER_AGENT,
        Accept: "application/geo+json",
    };
    try {
        const response = await fetch(url, { headers });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return (await response.json());
    }
    catch (error) {
        console.error("Error making NWS request:", error);
        return null;
    }
}
// Format alert data
function formatAlert(feature) {
    const props = feature.properties;
    return [
        `Event: ${props.event || "Unknown"}`,
        `Area: ${props.areaDesc || "Unknown"}`,
        `Severity: ${props.severity || "Unknown"}`,
        `Status: ${props.status || "Unknown"}`,
        `Headline: ${props.headline || "No headline"}`,
        "---",
    ].join("\n");
}
// Define Zod schemas for validation
const AlertsArgumentsSchema = z.object({
    state: z.string().length(2),
});
const ForecastArgumentsSchema = z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
});
// Create server instance
const server = new Server({
    name: "weather",
    version: "1.0.0",
}, {
    capabilities: {
        tools: {},
    },
});
// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
        if (name === "get-alerts") {
            const { state } = AlertsArgumentsSchema.parse(args);
            const stateCode = state.toUpperCase();
            const alertsUrl = `${NWS_API_BASE}/alerts?area=${stateCode}`;
            const alertsData = await makeNWSRequest(alertsUrl);
            if (!alertsData) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "Failed to retrieve alerts data",
                        },
                    ],
                };
            }
            const features = alertsData.features || [];
            if (features.length === 0) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `No active alerts for ${stateCode}`,
                        },
                    ],
                };
            }
            const formattedAlerts = features.map(formatAlert).slice(0, 20); // only take the first 20 alerts;
            const alertsText = `Active alerts for ${stateCode}:\n\n${formattedAlerts.join("\n")}`;
            return {
                content: [
                    {
                        type: "text",
                        text: alertsText,
                    },
                ],
            };
        }
        else if (name === "get-forecast") {
            const { latitude, longitude } = ForecastArgumentsSchema.parse(args);
            // Get grid point data
            const pointsUrl = `${NWS_API_BASE}/points/${latitude.toFixed(4)},${longitude.toFixed(4)}`;
            const pointsData = await makeNWSRequest(pointsUrl);
            if (!pointsData) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Failed to retrieve grid point data for coordinates: ${latitude}, ${longitude}. This location may not be supported by the NWS API (only US locations are supported).`,
                        },
                    ],
                };
            }
            const forecastUrl = pointsData.properties?.forecast;
            if (!forecastUrl) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "Failed to get forecast URL from grid point data",
                        },
                    ],
                };
            }
            // Get forecast data
            const forecastData = await makeNWSRequest(forecastUrl);
            if (!forecastData) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "Failed to retrieve forecast data",
                        },
                    ],
                };
            }
            const periods = forecastData.properties?.periods || [];
            if (periods.length === 0) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "No forecast periods available",
                        },
                    ],
                };
            }
            // Format forecast periods
            const formattedForecast = periods.map((period) => [
                `${period.name || "Unknown"}:`,
                `Temperature: ${period.temperature || "Unknown"}°${period.temperatureUnit || "F"}`,
                `Wind: ${period.windSpeed || "Unknown"} ${period.windDirection || ""}`,
                `${period.shortForecast || "No forecast available"}`,
                "---",
            ].join("\n"));
            const forecastText = `Forecast for ${latitude}, ${longitude}:\n\n${formattedForecast.join("\n")}`;
            return {
                content: [
                    {
                        type: "text",
                        text: forecastText,
                    },
                ],
            };
        }
        else {
            throw new Error(`Unknown tool: ${name}`);
        }
    }
    catch (error) {
        if (error instanceof z.ZodError) {
            throw new Error(`Invalid arguments: ${error.errors
                .map((e) => `${e.path.join(".")}: ${e.message}`)
                .join(", ")}`);
        }
        throw error;
    }
});
server.setRequestHandler(ListToolsRequestSchema, () => {
    return {
        tools: [
            {
                name: "get-alerts",
                description: "Get weather alerts for a state",
                inputSchema: {
                    type: "object",
                    properties: {
                        state: {
                            type: "string",
                            description: "Two-letter state code (e.g. CA, NY)",
                        },
                    },
                    required: ["state"],
                },
            },
            {
                name: "get-forecast",
                description: "Get weather forecast for a location",
                inputSchema: {
                    type: "object",
                    properties: {
                        latitude: {
                            type: "number",
                            description: "Latitude of the location",
                        },
                        longitude: {
                            type: "number",
                            description: "Longitude of the location",
                        },
                    },
                    required: ["latitude", "longitude"],
                },
            },
        ],
    };
});
async function main() {
    let activeTransport = null;
    const httpServer = http.createServer(async (req, res) => {
        // Handle SSE connection
        if (req.method === 'GET' && req.url === '/mcp') {
            try {
                // Close any existing transport
                if (activeTransport) {
                    activeTransport.close();
                }
                const transport = new SSEServerTransport("/mcp", res);
                activeTransport = transport;
                // Handle transport errors
                transport.onerror = (err) => {
                    console.error('Transport error:', err);
                    activeTransport = null;
                };
                transport.onclose = () => {
                    console.log('Client disconnected');
                    activeTransport = null;
                    server.close();
                };
                await server.connect(transport);
            }
            catch (err) {
                console.error('Error setting up SSE connection:', err);
                res.writeHead(500);
                res.end();
            }
        }
        // Handle POST messages
        else if (req.method === 'POST' && req.url?.startsWith('/mcp')) {
            if (!activeTransport) {
                res.writeHead(400);
                res.end('No active SSE connection');
                return;
            }
            try {
                await activeTransport.handlePostMessage(req, res);
            }
            catch (err) {
                console.error('Error handling POST message:', err);
                if (!res.headersSent) {
                    res.writeHead(500);
                    res.end('Internal server error');
                }
            }
        }
    });
    const port = 8000;
    httpServer.listen(port, () => {
        console.log(`Weather MCP Server running on http://localhost:${port}`);
    });
}
main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});