
import { z } from "zod";

export const SearchArgs = z.object({
  query: z.string().min(3).max(300),
  recency: z.enum(["day", "week", "month", "year"]).optional(),
  after_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  domains: z.array(z.string().max(100)).max(8).optional()
}).strict();

export const searchTool = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the public web for information that is current, " +
      "unknown, uncertain, or requires external verification. " +
      "For comparisons involving independent products, companies, " +
      "or entities, issue separate focused search calls. " +
      "Do not search for stable facts or calculations you can answer reliably.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string" },
        recency: {
          type: "string",
          enum: ["day", "week", "month", "year"]
        },
        after_date: { type: "string" },
        end_date: { type: "string" },
        domains: {
          type: "array",
          items: { type: "string" }
        }
      },
      required: ["query"]
    }
  }
};

export function parseSearchCall(call) {
  if (
    call?.type !== "function" ||
    call.function?.name !== "web_search"
  ) {
    throw new Error("Unsupported tool call.");
  }

  let args;

  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    throw new Error("Invalid JSON in search arguments.");
  }

  return SearchArgs.parse(args);
}

export function createSearchKey(args) {
  return [
    args.query.toLowerCase().trim(),
    args.recency || "",
    args.after_date || "",
    args.end_date || "",
    (args.domains || []).slice().sort().join(",")
  ].join("|");
}
