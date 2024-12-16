import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  CallToolResult,
  TextContent,
  ImageContent,
  Tool,
  Prompt,
} from "@modelcontextprotocol/sdk/types.js";
import { chromium, Browser, Page, Locator } from "playwright";



const locatorInputSchemaProp =  {
  type: "string",
  description: 'Selector that fulfills page.locator(selector). Prefer text and index selections, evaluate code if you need to to find it with query selection'
}


// Define the tools once to avoid repetition
const TOOLS: Tool[] = [
  {
    name: "playwright_navigate",
    description: "Navigate to a URL",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
      },
      required: ["url"],
    },
  },
  {
    name: "playwright_screenshot",
    description: "Take a screenshot of the current page or a specific element",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name for the screenshot" },
        locator: locatorInputSchemaProp,
        fullpage: { type: "boolean", description: "Screenshot of a full scrollable page", default: false}
      },
      required: ["name"],
    },
  },
  {
    name: "playwright_click",
    description: "Click an element on the page using a playwright locator",
    inputSchema: {
      type: "object",
      properties: {
          locator: locatorInputSchemaProp,
        }
      },
    required: ["locator"],
  },
  {
    name: "playwright_find_locators",
    description: "Get a list of interactive locators on the current page",
    inputSchema: {
      type: "object",
      properties: {
          type: "text",
          value: { type: "string", description: "Any specific details about what locators to return" },
      },
    }
  },
  {
    name: "playwright_fill",
    description: "Fill out an input field",
    inputSchema: {
      type: "object",
      properties: {
        locator: locatorInputSchemaProp,
        value: { type: "string", description: "Value to fill" },
      },
      required: ["locator", "value"],
    },
  },
  {
    name: "playwright_highlight",
    description: "Highlight an element on the page",
    inputSchema: {
      type: "object",
      properties: {
        locator: locatorInputSchemaProp,
      },
      required: ["locator"],
    },
  },
  {
    name: "playwright_evaluate",
    description: "Execute JavaScript in the browser console",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: "JavaScript code to execute" },
      },
      required: ["script"],
    },
  },
];

const PROMPTS: Prompt[] = [
  {
    name: "playwright-page-object-generate",
    description: "Using a list of playwright locators, generate playwright Page Object Model code in typescript. No methods, just locators",
    arguments: [
      {
        name: "locators",
        description: "A list of playwright locators",
        required: true
    }
    ]
  },
]


// Global state
let browser: Browser | undefined;
let page: Page | undefined;
const consoleLogs: string[] = [];
const screenshots = new Map<string, string>();

async function getLocatorText(locator: Locator): Promise<string>{
    return locator.toString()
}

async function findInteractiveElements(page: Page): Promise<string[]> {
  const locators: Locator[][] = await Promise.all([
    page.getByRole("button").all(),
    page.getByRole("textbox").all(),
    page.getByRole("combobox").all(),
    page.getByRole("link").all(),
    page.getByRole("checkbox").all(),
    page.getByRole("radio").all(),
    page.getByRole("tab").all(),
    page.getByRole("tabpanel").all(),
    page.getByRole("menu").all(),
    page.getByRole("menuitem").all(),
    page.getByRole("listbox").all(),
    page.getByRole("option").all(),
    page.getByRole("dialog").all(),
    page.getByRole("alert").all(),
    page.getByRole("tooltip").all(),
    page.getByRole("slider").all(),
    page.getByRole("spinbutton").all(),
    page.getByRole("searchbox").all(),
    page.getByRole("progressbar").all(),
    page.getByRole("switch").all()
  ]);

const allLocatorStrings: string[] = [];

  for (const locatorArray of locators) {
    for (const locator of locatorArray) {
      allLocatorStrings.push(await getLocatorText(locator));
    }
  }
  console.log(allLocatorStrings)
  return allLocatorStrings;
}
async function ensureBrowser() {
  if (!browser) {
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext()
    page = await context.newPage()

    page.on("console", (msg) => {
      const logEntry = `[${msg.type()}] ${msg.text()}`;
      consoleLogs.push(logEntry);
      server.notification({
        method: "notifications/resources/updated",
        params: { uri: "console://logs" },
      });
    });
  }
  return page!;
}
async function cleanupBrowser() {
  if (browser) {
    await browser.close()
  }
}

declare global {
  interface Window {
    mcpHelper: {
      logs: string[],
      originalConsole: Partial<typeof console>,
    }
  }
}

async function takeScreenshot(page: Page, name: string) {
  const buf = await page.screenshot();
  const screenshot = buf.toString("base64");
  screenshots.set(name, screenshot);
  server.notification({
    method: "notifications/resources/list_changed",
  });
  return screenshot;
}

async function handleToolCall(name: string, args: any): Promise<CallToolResult> {
  const page = await ensureBrowser();
  switch (name) {
    case "playwright_navigate": {
      console.error(`Running navigate to await page.goto(${args.url})`)
      await page.goto(args.url);
      const screenshot = await takeScreenshot(page, `navigate_${Date.now()}`);
      return {
        content: [
          {
            type: "text",
            text: `Navigated to ${args.url}`,
          },
          {
            type: "image",
            data: screenshot,
            mimeType: "image/png",
          } as ImageContent
        ],
        isError: false,
      };
    }

    case "playwright_screenshot": {
      const buf = await page.screenshot({fullPage: args.fullpage})
      const screenshot = buf.toString("base64")

      if (!screenshot) {
        return {
          content: [{
            type: "text",
            text: args.locator ? `Element not found: ${args.locator}` : "Screenshot failed",
          }],
          isError: true,
        };
      }

      screenshots.set(args.name, screenshot as string);
      server.notification({
        method: "notifications/resources/list_changed",
      });

      return {
        content: [
          {
            type: "text",
            text: `${args.fullpage ? "Full Page": undefined }Screenshot '${args.name}' taken at`,
          } as TextContent,
          {
            type: "image",
            data: screenshot,
            mimeType: "image/png",
          } as ImageContent,
        ],
        isError: false,
      };
    }

    case "playwright_find_locators": {
      try {
        const matches = await findInteractiveElements(page)
        console.log(matches)
        return {
          content: [{
            type: "text",
            text: JSON.stringify(matches)
          }],
          isError: false
        }
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Failed to find interactive elements: ${(error as Error).message}`
          }],
          isError: true
        };
      }
    }
    case "playwright_click": {

      try {
        console.error(args)
        await page.locator(args.locator).click()
        await page.waitForTimeout(2000)
        const screenshot = await takeScreenshot(page, `click_${Date.now()}`);
        return {
          content: [
            {
              type: "text",
              text: `Clicked ${args.locator}`,
            },
            {
              type: "image",
              data: screenshot,
              mimeType: "image/png",
            } as ImageContent
          ],
          isError: false,
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Failed to click ${args.locator}: ${(error as Error).message}`,
          }],
          isError: true,
        };
      }
    }
    case "playwright_fill": {
      try {
        await page.locator(args.locator).fill(args.value);
        await page.waitForTimeout(2000)
        const screenshot = await takeScreenshot(page, `click_${Date.now()}`);        return {
          content: [
            {
              type: "text",
              text: `Filled ${args.locator} with: ${args.value}`,
            },
            {
              type: "image",
              data: screenshot,
              mimeType: "image/png",
            } as ImageContent
          ],
          isError: false,
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Failed to fill ${args.locator}: ${(error as Error).message}`,
          }],
          isError: true,
        };
      }
    }

    case "playwright_highlight": {
      try {
        await (args.locator).highlight();
        const screenshot = await takeScreenshot(page, `hover_${Date.now()}`);
        return {
          content: [
            {
              type: "text",
              text: `Hovered ${args.locator}`,
            },
            {
              type: "image",
              data: screenshot,
              mimeType: "image/png",
            } as ImageContent
          ],
          isError: false,
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Failed to hover ${args.locator}: ${(error as Error).message}`,
          }],
          isError: true,
        };
      }
    }

    case "playwright_evaluate": {
      try {
        await page.evaluate(() => {
          window.mcpHelper = {
            logs: [],
            originalConsole: { ...console },
          };

          ['log', 'info', 'warn', 'error'].forEach(method => {
            (console as any)[method] = (...args: any[]) => {
              window.mcpHelper.logs.push(`[${method}] ${args.join(' ')}`);
              (window.mcpHelper.originalConsole as any)[method](...args);
            };
          } );
        } );

        const result = await page.evaluate( args.script );
        const screenshot = await takeScreenshot(page, `evaluate_${Date.now()}`);

        const logs = await page.evaluate(() => {
          Object.assign(console, window.mcpHelper.originalConsole);
          const logs = window.mcpHelper.logs;
          delete ( window as any).mcpHelper;
          return logs;
        });

        return {
          content: [
            {
              type: "text",
              text: `Execution result:\n${JSON.stringify(result, null, 2)}\n\nConsole output:\n${logs.join('\n')}`,
            },
            {
              type: "image",
              data: screenshot,
              mimeType: "image/png",
            } as ImageContent
          ],
          isError: false,
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Script execution failed: ${(error as Error).message}`,
          }],
          isError: true,
        };
      }
    }

    default:
      return {
        content: [{
          type: "text",
          text: `Unknown tool: ${name}`,
        }],
        isError: true,
      };
  }
}

const server = new Server(
  {
    name: "example-servers/playwright",
    version: "0.1.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
      prompts: {},
      logging: {}
    },
  },
);


// Setup request handlers
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: "console://logs",
      mimeType: "text/plain",
      name: "Browser console logs",
    },
    ...Array.from(screenshots.keys()).map(name => ({
      uri: `screenshot://${name}`,
      mimeType: "image/png",
      name: `Screenshot: ${name}`,
    })),
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri.toString();

  if (uri === "console://logs") {
    return {
      contents: [{
        uri,
        mimeType: "text/plain",
        text: consoleLogs.join("\n"),
      }],
    };
  }

  if (uri.startsWith("screenshot://")) {
    const name = uri.split("://")[1];
    const screenshot = screenshots.get(name);
    if (screenshot) {
      return {
        contents: [{
          uri,
          mimeType: "image/png",
          blob: screenshot,
        }],
      };
    }
  }

  throw new Error(`Resource not found: ${uri}`);
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) =>
  handleToolCall(request.params.name, request.params.arguments ?? {})
);

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: PROMPTS,
}))


async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.on("SIGINT", async () => {
    await server.close();
    process.exit(0);
  });
}

runServer().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
