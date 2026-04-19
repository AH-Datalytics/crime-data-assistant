import { NextResponse } from "next/server";
import { generatePageToken } from "@/lib/page-token";

export async function GET() {
  return NextResponse.json({ token: generatePageToken() });
}
