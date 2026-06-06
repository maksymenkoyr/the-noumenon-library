import OpenAI from "openai";
import { NextResponse } from "next/server";

const client = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

export async function GET() {
  const response = await client.chat.completions.create({
    model: "nvidia/nemotron-3-super-120b-a12b:free",
    messages: [
      {
        role: "user",
        content:
          "You are a page in an infinite library. Every text that could ever be written already exists here. You do not know what you are. Generate the text found on this page.",
      },
    ],
  });

  const text = response.choices[0].message.content;
  return NextResponse.json({ text });
}
