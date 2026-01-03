/**
 * Gemini API client for entity extraction
 * Uses Gemini 2.5 Flash for parsing unstructured text
 */

import { getEnv } from '@/lib/env';
import { logger } from '@/lib/logger';

const log = logger.child({ client: 'gemini' });

// Extracted entity structure
export interface ExtractedEntities {
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  email: string | null;
  streetAddress: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  confidence: 'high' | 'medium' | 'low';
}

// Gemini API response structure
interface GeminiResponse {
  candidates: Array<{
    content: {
      parts: Array<{
        text: string;
      }>;
    };
    finishReason: string;
  }>;
}

const EXTRACTION_PROMPT = `You are an entity extraction assistant. Extract contact information from the following conversation text.

Return a JSON object with these fields (use null if not found):
- firstName: The person's first name
- lastName: The person's last name
- fullName: The complete name if given as one string
- email: Email address
- streetAddress: Street address (number and street name only)
- city: City name
- state: State (2-letter abbreviation preferred)
- zipCode: ZIP/postal code
- confidence: Your confidence in the extractions ("high", "medium", or "low")

Rules:
- Only extract information the person explicitly states about themselves
- Do not infer or guess information
- If someone says "my name is John" extract firstName: "John"
- If someone gives a full address, parse it into components
- Set confidence to "high" if entities are clearly stated, "medium" if somewhat ambiguous, "low" if uncertain

Respond with ONLY the JSON object, no markdown or explanation.

Text to analyze:
`;

/**
 * Extract entities from unstructured text using Gemini
 */
export async function extractEntities(text: string): Promise<ExtractedEntities | null> {
  const env = getEnv();

  if (!env.gemini.apiKey) {
    log.warn('Gemini API key not configured, skipping entity extraction');
    return null;
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${env.gemini.apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: EXTRACTION_PROMPT + text,
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.1, // Low temperature for consistent extraction
            maxOutputTokens: 500,
          },
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      log.error('Gemini API error', new Error(error), { status: response.status });
      return null;
    }

    const data = (await response.json()) as GeminiResponse;
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!rawText) {
      log.warn('No response from Gemini');
      return null;
    }

    // Parse JSON response (handle potential markdown code blocks)
    const jsonText = rawText.replace(/```json\n?|\n?```/g, '').trim();
    const entities = JSON.parse(jsonText) as ExtractedEntities;

    // Validate required fields exist
    if (typeof entities.confidence !== 'string') {
      entities.confidence = 'low';
    }

    log.info('Extracted entities', {
      hasName: !!(entities.firstName || entities.lastName || entities.fullName),
      hasEmail: !!entities.email,
      hasAddress: !!entities.streetAddress,
      confidence: entities.confidence,
    });

    return entities;
  } catch (error) {
    log.error('Entity extraction failed', error as Error);
    return null;
  }
}

/**
 * Check if extracted entities have any useful data
 */
export function hasUsefulEntities(entities: ExtractedEntities | null): boolean {
  if (!entities) return false;

  return !!(
    entities.firstName ||
    entities.lastName ||
    entities.fullName ||
    entities.email ||
    entities.streetAddress
  );
}
