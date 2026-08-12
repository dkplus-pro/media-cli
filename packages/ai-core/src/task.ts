import type { z } from "zod";

export interface AIImage {
  mimeType: string;
  base64Data?: string;
  dataUrl?: string;
}

export interface AITask<Result> {
  feature: string;
  prompt: string;
  images?: readonly AIImage[];
  responseSchema: z.ZodType<Result>;
}

export interface AIProvider {
  execute<Result>(task: AITask<Result>): Promise<Result>;
}

export interface FetchRequest {
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

export type FetchLike = (url: string, request: FetchRequest) => Promise<Response>;
