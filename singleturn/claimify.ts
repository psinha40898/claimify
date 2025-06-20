import dotenv from 'dotenv';
dotenv.config();
import { z } from "zod"
import { LanguageModelV1 } from 'ai';
import { readFileSync, writeFileSync } from 'fs';
import { generateText, generateObject } from 'ai';
import { google } from '@ai-sdk/google';
import { openai } from '@ai-sdk/openai';
import { xai } from '@ai-sdk/xai';
import { anthropic } from '@ai-sdk/anthropic';
import { join } from 'path';
import { EVAL_CREATE_ELEMENTS_SYS, EVAL_CREATE_ELEMENTS_USER, EVAL_ELEMENT_COVERAGE_SYS, EVAL_ELEMENT_COVERAGE_USER, EVAL_ENTAILMENT_SYS, EVAL_ENTAILMENT_USER } from '../prompts/claimify';
interface BaselineClaimData {
    claim: string
    sentence: string
    excerpt: string
    query: string
    filename: string
    sentenceIndex: number
}


import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { ElementCoverageEvaluationSchema } from '../claimify'

const openrouter = createOpenRouter({
    apiKey:
        ''
})
const fouro = openrouter.chat(`openai/gpt-4o-2024-11-20`)
const fourone = openrouter.chat(`openai/gpt-4.1`)
interface InputData {
    filename: string
    query: string
    response: string
    tokenized_response: string[]
}
const ElementSchema = z.object({
    element: z.string().describe("The extracted element from the sentence"),
    verifiability: z
        .enum([
            "contains verifiable information",
            "does not contain verifiable information",
            "it's a generic statement, so it does not contain verifiable information",
        ])
        .describe("Whether the element contains verifiable information"),
})



// Schema for extracting claims from the entire response
const BaselineExtractionSchema = z.object({
    extractedClaims: z
        .array(z.string())
        .describe("Array of decontextualized factual claims formatted as 'true or false?' questions"),
})
export const ElementExtractionSchema = z.object({
    originalSentence: z.string().describe("The original sentence S, exactly as written"),

    clarificationsNeeded: z
        .string()
        .describe("Answer to whether clarifications are needed to understand S based on its context"),

    restatedSentence: z.string().describe("S_restated - the sentence restated with clarifications if needed"),

    statementsAndActionsRuleApplies: z.boolean().describe("Whether the Statements and Actions Rule applies"),

    statementsAndActionsRuleExplanation: z
        .string()
        .describe("Explanation of why the Statements and Actions Rule does or doesn't apply"),

    elements: z.array(ElementSchema).describe("All elements extracted from S_restated with their verifiability"),
})
export type ElementExtractionOutput = z.infer<typeof ElementExtractionSchema>
// Utility function to create excerpts
function createExcerpt(
    tokenizedSentences: string[],
    sentenceIndex: number,
    preceding: number,
    following: number,
): string {
    const start = Math.max(0, sentenceIndex - preceding)
    const end = Math.min(tokenizedSentences.length, sentenceIndex + following + 1)
    return tokenizedSentences.slice(start, end).join(" ")
}

const BASELINE_SYSTEM = `You are an expert fact-checking assistant. Your task is to extract the smallest possible verifiable factual claims from a given response to a question.

For each response, you must:
1. Identify all factual statements that can be independently verified
2. Break down complex sentences into their MOST ATOMIC verifiable components - if a sentence contains multiple facts, separate each one
3. Remove subjective opinions, rhetorical questions, and unverifiable statements
4. Ensure each claim is fully decontextualized and can stand alone for fact-checking
5. Add essential context in square brackets when needed for clarity
6. Format each claim as a "true or false?" question for fact-checkers

Guidelines:
- Ignore citation markers like [^1^], [^2^], etc.
- Skip conversational elements like "That's interesting" or "Do you have a favorite?"
- Each claim should test ONE specific fact only
- If a sentence says "X was Y and did Z in year W", create separate claims for: "X was Y", "X did Z", "X did Z in year W"
- Separate descriptive attributes from actions from temporal information
- Add bracketed context only when absolutely necessary for understanding
- Prefer multiple simple claims over fewer complex ones

CRITICAL: Break compound statements into their smallest verifiable units. For example:
- Instead of: "John Smith, a 45-year-old engineer from Boston, won the Nobel Prize in Physics in 2023"
- Create: "John Smith won the Nobel Prize in Physics - true or false?", "John Smith won the Nobel Prize in Physics in 2023 - true or false?", "John Smith is 45 years old - true or false?", "John Smith is an engineer - true or false?", "John Smith is from Boston - true or false?"

IMPORTANT: Each claim must be fully decontextualized so that a fact-checker with no knowledge of the original question or context can still verify it independently.`

const BASELINE_USER = (query: string, response: string) => {
    return `Question: ${query}

Response: ${response}

Extract all verifiable factual claims from this response. Each claim should be atomic, decontextualized, and formatted as a "true or false?" question that can be independently fact-checked.`
}

async function baselineClaimExtractor(
    inputFilePath: string,
    outputJsonFilePath: string,
    model: LanguageModelV1,
): Promise<void> {
    console.log(`\n--- Starting Baseline Claim Extraction ---`)
    console.log(`Reading data from: ${inputFilePath}`)
    console.log(`Saving outputs to: ${outputJsonFilePath}`)

    try {
        const rawData = readFileSync(inputFilePath, "utf-8")
        const data: InputData[] = JSON.parse(rawData)

        if (!Array.isArray(data)) {
            console.error(`Error: Expected input JSON to be an array, but got ${typeof data}.`)
            return
        }

        // This will be the final nested array - one sub-array per question+answer pair
        const finalGroupedOutput: any[][] = []
        let processedItemsCount = 0

        for (let itemIndex = 0; itemIndex < data.length; itemIndex++) {
            const item = data[itemIndex]
            const { filename, query, response, tokenized_response } = item

            console.log(`\nProcessing item ${itemIndex + 1}/${data.length}: ${filename}`)
            console.log(`Query: "${query.substring(0, 50)}..."`)

            const currentItemClaims: any[] = []

            try {
                // Extract all claims from the entire response in one LLM call
                const { object: llmOutput } = await generateObject({
                    model: model,
                    schema: BaselineExtractionSchema,
                    system: BASELINE_SYSTEM,
                    prompt: BASELINE_USER(query, response),
                })

                console.log(`  - Extracted ${llmOutput.extractedClaims.length} claims`)

                // For each extracted claim, find the best matching sentence and create output object
                for (let claimIndex = 0; claimIndex < llmOutput.extractedClaims.length; claimIndex++) {
                    const claim = llmOutput.extractedClaims[claimIndex]

                    // Find the sentence that best matches this claim (simple heuristic: most word overlap)
                    let bestSentenceIndex = 0
                    let maxOverlap = 0

                    for (let sentIndex = 0; sentIndex < tokenized_response.length; sentIndex++) {
                        const sentence = tokenized_response[sentIndex]
                        const claimWords = claim.toLowerCase().split(/\s+/)
                        const sentenceWords = sentence.toLowerCase().split(/\s+/)

                        const overlap = claimWords.filter((word) =>
                            sentenceWords.some((sentWord) => sentWord.includes(word) || word.includes(sentWord)),
                        ).length

                        if (overlap > maxOverlap) {
                            maxOverlap = overlap
                            bestSentenceIndex = sentIndex
                        }
                    }

                    const bestSentence = tokenized_response[bestSentenceIndex]
                    const excerpt = createExcerpt(tokenized_response, bestSentenceIndex, 5, 5)

                    currentItemClaims.push({
                        claim: claim,
                        sentence: bestSentence,
                        excerpt: excerpt,
                        query: query,
                        filename: filename,
                        sentenceIndex: bestSentenceIndex,
                    })
                }
            } catch (llmError) {
                console.error(`    Error calling LLM for item ${itemIndex + 1}:`, llmError)
                // Add empty array for this item on error
            }

            // Add this item's claims as a sub-array
            finalGroupedOutput.push(currentItemClaims)
            processedItemsCount++
        }

        // Write the nested array to a JSON file
        writeFileSync(outputJsonFilePath, JSON.stringify(finalGroupedOutput, null, 2), "utf-8")

        const totalClaims = finalGroupedOutput.reduce((sum, itemClaims) => sum + itemClaims.length, 0)
        console.log(`\nSuccessfully processed ${processedItemsCount} items. Total claims: ${totalClaims}`)
        console.log(`All outputs saved to '${outputJsonFilePath}'`)
    } catch (error) {
        if (error instanceof Error) {
            console.error(`Error during Baseline Claim Extraction: ${error.message}`)
        } else {
            console.error(`An unknown error occurred during Baseline Claim Extraction: ${error}`)
        }
        throw error // Re-throw to indicate failure
    }
}

// Same schema as the original entailment evaluator
const EntailmentOutputSchema = z.object({
    sentenceS: z.string().describe("The sentence of interest (S) exactly as written"),
    contextDescription: z.string().describe("Description of how S would be interpreted in context"),
    claimC: z.string().describe("The claim (C) exactly as written"),
    claimInterpretation: z.string().describe("How a reader would interpret the claim"),
    elementsOfC: z.array(z.string()).describe("All elements/components of claim C"),
    statementsAndActionsRuleApplies: z.boolean().describe("Whether the Statements and Actions Rule applies to S"),
    statementsAndActionsRuleReasoning: z
        .string()
        .describe("Reasoning for whether the rule applies or qualifies as exception"),
    elementAnalysis: z.string().describe("Step-by-step reasoning for each element of C"),
    finalConclusion: z
        .enum(["S entails all elements of C", "S does not entail all elements of C"])
        .describe("Final entailment conclusion"),
})

type EntailmentOutput = z.infer<typeof EntailmentOutputSchema>

async function baselineEntailmentEvaluator(
    inputFilePath: string,
    outputJsonFilePath: string,
    model: LanguageModelV1,
): Promise<void> {
    console.log(`\n--- Starting Baseline Entailment Evaluation Step ---`)
    console.log(`Reading data from: ${inputFilePath}`)
    console.log(`Saving LLM outputs to: ${outputJsonFilePath}`)

    try {
        const rawData = readFileSync(inputFilePath, "utf-8")
        const data: BaselineClaimData[][] = JSON.parse(rawData)

        if (!Array.isArray(data)) {
            console.error(`Error: Expected input JSON to be an array, but got ${typeof data}.`)
            return
        }

        // This will be the final array of arrays
        const finalGroupedOutput: any[][] = []
        let processedDocumentsCount = 0

        for (let docIndex = 0; docIndex < data.length; docIndex++) {
            const documentClaims = data[docIndex]
            console.log(`\nProcessing document ${docIndex + 1}/${data.length}`)
            console.log(`  - Found ${documentClaims.length} claims to evaluate`)

            const currentDocumentOutputs: any[] = []

            // Loop through each claim in this document
            for (let claimIndex = 0; claimIndex < documentClaims.length; claimIndex++) {
                const claimData = documentClaims[claimIndex]
                const { claim, sentence, excerpt, query } = claimData

                console.log(`    - Evaluating claim ${claimIndex + 1}/${documentClaims.length}: "${claim.substring(0, 50)}..."`)

                try {
                    const { object: llmResponse } = await generateObject({
                        model: model,
                        schema: EntailmentOutputSchema,
                        system: EVAL_ENTAILMENT_SYS,
                        prompt: EVAL_ENTAILMENT_USER(query, excerpt, sentence, claim),
                    })

                    currentDocumentOutputs.push({
                        ...claimData, // Include all original claim data
                        entailmentEvaluation: llmResponse,
                    })
                } catch (llmError) {
                    console.error(`      Error calling LLM for claim ${claimIndex + 1} in document ${docIndex}:`, llmError)

                    // Add error result with the expected schema structure
                    const errorOutput: EntailmentOutput = {
                        sentenceS: sentence,
                        contextDescription: `ERROR: ${llmError}`,
                        claimC: claim,
                        claimInterpretation: `ERROR: ${llmError}`,
                        elementsOfC: [],
                        statementsAndActionsRuleApplies: false,
                        statementsAndActionsRuleReasoning: `ERROR: ${llmError}`,
                        elementAnalysis: `ERROR: ${llmError}`,
                        finalConclusion: "S does not entail all elements of C",
                    }

                    currentDocumentOutputs.push({
                        ...claimData,
                        entailmentEvaluation: errorOutput,
                    })
                }
            }

            finalGroupedOutput.push(currentDocumentOutputs)
            processedDocumentsCount++
        }

        // Write the array of arrays to a JSON file
        writeFileSync(outputJsonFilePath, JSON.stringify(finalGroupedOutput, null, 2), "utf-8")
        console.log(
            `\nSuccessfully processed ${processedDocumentsCount} documents. All LLM outputs saved to '${outputJsonFilePath}'`,
        )
    } catch (error) {
        if (error instanceof Error) {
            console.error(`Error during Baseline Entailment Evaluation Step: ${error.message}`)
        } else {
            console.error(`An unknown error occurred during Baseline Entailment Evaluation Step: ${error}`)
        }
        throw error // Re-throw to indicate failure
    }
}

async function baselineElementExtractor(
    inputFilePath: string,
    outputJsonFilePath: string,
    model: LanguageModelV1,
): Promise<void> {
    console.log(`\n--- Starting Baseline Element Extraction Step ---`)
    console.log(`Reading data from: ${inputFilePath}`)
    console.log(`Saving LLM outputs to: ${outputJsonFilePath}`)

    try {
        const rawData = readFileSync(inputFilePath, "utf-8")
        const data: BaselineClaimData[][] = JSON.parse(rawData)

        if (!Array.isArray(data)) {
            console.error(`Error: Expected input JSON to be an array, but got ${typeof data}.`)
            return
        }

        // This will be the final array of arrays
        const finalGroupedOutput: any[][] = []
        let processedDocumentsCount = 0

        for (let docIndex = 0; docIndex < data.length; docIndex++) {
            const documentClaims = data[docIndex]
            console.log(`\nProcessing document ${docIndex + 1}/${data.length}`)

            const currentDocumentOutputs: any[] = []

            for (let claimIndex = 0; claimIndex < documentClaims.length; claimIndex++) {
                const claimItem = documentClaims[claimIndex]
                const { query, excerpt, sentence, claim, filename, sentenceIndex } = claimItem

                console.log(`\nProcessing claim ${claimIndex + 1}/${documentClaims.length}: "${sentence.substring(0, 70)}..."`)

                try {
                    const { object: llmResponse } = await generateObject({
                        model: model,
                        schema: ElementExtractionSchema,
                        system: EVAL_CREATE_ELEMENTS_SYS,
                        prompt: EVAL_CREATE_ELEMENTS_USER(query, excerpt, sentence),
                    })

                    // Add the claim data with extracted elements and the claim for coverage evaluation
                    currentDocumentOutputs.push({
                        query: query,
                        excerpt: excerpt,
                        sentence: sentence,
                        claims: [claim], // Single claim in array format to match Claimify structure
                        elementExtraction: llmResponse,
                        // Keep original metadata
                        filename: filename,
                        sentenceIndex: sentenceIndex,
                    })

                    console.log(
                        `    - Successfully extracted ${llmResponse.elements.length} elements for claim ${claimIndex + 1}`,
                    )
                } catch (llmError) {
                    console.error(`      Error calling LLM for claim ${claimIndex + 1}:`, llmError)

                    // Add error result
                    currentDocumentOutputs.push({
                        query: query,
                        excerpt: excerpt,
                        sentence: sentence,
                        claims: [claim],
                        elementExtraction: `ERROR: ${llmError}`,
                        filename: filename,
                        sentenceIndex: sentenceIndex,
                    })
                }
            }

            finalGroupedOutput.push(currentDocumentOutputs)
            processedDocumentsCount++
        }

        // Write the array of arrays to a JSON file
        writeFileSync(outputJsonFilePath, JSON.stringify(finalGroupedOutput, null, 2), "utf-8")
        console.log(
            `\nSuccessfully processed ${processedDocumentsCount} documents. All LLM outputs saved to '${outputJsonFilePath}'`,
        )
    } catch (error) {
        if (error instanceof Error) {
            console.error(`Error during Baseline Element Extraction Step: ${error.message}`)
        } else {
            console.error(`An unknown error occurred during Baseline Element Extraction Step: ${error}`)
        }
        throw error // Re-throw to indicate failure
    }
}
interface BaselineElementData {
    query: string
    excerpt: string
    sentence: string
    claims: string[]
    elementExtraction: ElementExtractionOutput | string
    filename: string
    sentenceIndex: number
}
async function baselineCoverageEvaluator(
    inputFilePath: string,
    outputJsonFilePath: string,
    model: LanguageModelV1,
): Promise<void> {
    console.log(`\n--- Starting Baseline Coverage Evaluation Step ---`)
    console.log(`Reading data from: ${inputFilePath}`)
    console.log(`Saving LLM outputs to: ${outputJsonFilePath}`)

    try {
        const rawData = readFileSync(inputFilePath, "utf-8")
        const data: (BaselineElementData | {})[][] = JSON.parse(rawData)

        if (!Array.isArray(data)) {
            console.error(`Error: Expected input JSON to be an array, but got ${typeof data}.`)
            return
        }

        // This will be the final array of arrays
        const finalGroupedOutput: any[][] = []
        let processedDocumentsCount = 0

        for (let docIndex = 0; docIndex < data.length; docIndex++) {
            const documentClaims = data[docIndex]
            console.log(`\nProcessing document ${docIndex + 1}/${data.length}`)

            const currentDocumentOutputs: any[] = []

            for (let claimIndex = 0; claimIndex < documentClaims.length; claimIndex++) {
                const claimItem = documentClaims[claimIndex]

                // Check if it's an empty object (pruned sentence)
                if (Object.keys(claimItem).length === 0) {
                    console.log(`  - Skipping empty object at claim ${claimIndex + 1}`)
                    currentDocumentOutputs.push({}) // Add empty object to result
                    continue
                }

                const elementData = claimItem as BaselineElementData
                const { query, excerpt, sentence, claims, elementExtraction, filename, sentenceIndex } = elementData

                // Skip if element extraction failed
                if (typeof elementExtraction === "string") {
                    console.log(`  - Skipping claim ${claimIndex + 1} due to element extraction error`)
                    currentDocumentOutputs.push({
                        ...elementData,
                        coverageEvaluation: `SKIPPED: Element extraction failed - ${elementExtraction}`,
                    })
                    continue
                }

                console.log(`\nProcessing claim ${claimIndex + 1}/${documentClaims.length}: "${sentence.substring(0, 70)}..."`)
                console.log(`  - Found ${claims.length} claims and ${elementExtraction.elements.length} elements`)

                try {
                    // Format claims and elements for the prompt
                    const claimsText = claims.map((claim, idx) => `${idx + 1}. ${claim}`).join("\n")
                    const elementsText = elementExtraction.elements
                        .map((element, idx) => `${idx + 1}. ${element.element} -> ${element.verifiability}`)
                        .join("\n")

                    const { object: llmResponse } = await generateObject({
                        model: model,
                        schema: ElementCoverageEvaluationSchema,
                        system: EVAL_ELEMENT_COVERAGE_SYS,
                        prompt: EVAL_ELEMENT_COVERAGE_USER(query, excerpt, claimsText, elementsText),
                    })

                    // Add the claim data with structured coverage evaluation
                    currentDocumentOutputs.push({
                        query: query,
                        excerpt: excerpt,
                        sentence: sentence,
                        claims: claims,
                        elementExtraction: elementExtraction,
                        coverageEvaluation: llmResponse,
                        filename: filename,
                        sentenceIndex: sentenceIndex,
                    })

                    console.log(
                        `    - Successfully evaluated coverage for claim ${claimIndex + 1}: TP=${llmResponse.metrics.truePositives}, FN=${llmResponse.metrics.falseNegatives}, FP=${llmResponse.metrics.falsePositives}, TN=${llmResponse.metrics.trueNegatives}`,
                    )
                } catch (llmError) {
                    console.error(`      Error calling LLM for claim ${claimIndex + 1}:`, llmError)

                    // Add error result
                    currentDocumentOutputs.push({
                        query: query,
                        excerpt: excerpt,
                        sentence: sentence,
                        claims: claims,
                        elementExtraction: elementExtraction,
                        coverageEvaluation: `ERROR: ${llmError}`,
                        filename: filename,
                        sentenceIndex: sentenceIndex,
                    })
                }
            }

            finalGroupedOutput.push(currentDocumentOutputs)
            processedDocumentsCount++
        }

        // Write the array of arrays to a JSON file
        writeFileSync(outputJsonFilePath, JSON.stringify(finalGroupedOutput, null, 2), "utf-8")
        console.log(
            `\nSuccessfully processed ${processedDocumentsCount} documents. All LLM outputs saved to '${outputJsonFilePath}'`,
        )
    } catch (error) {
        if (error instanceof Error) {
            console.error(`Error during Baseline Coverage Evaluation Step: ${error.message}`)
        } else {
            console.error(`An unknown error occurred during Baseline Coverage Evaluation Step: ${error}`)
        }
        throw error // Re-throw to indicate failure
    }
}

// baselineClaimExtractor(`claim_data/bingCheck_tokenized_truncated.json`, `claim_data/baseline_output.json`, google("gemini-2.5-pro-preview-05-06"));

// baselineEntailmentEvaluator(`claim_data/baseline_output.json`, `claim_data/baseline_output_eval_entailment.json`, google("gemini-2.5-flash-preview-04-17"))

// baselineElementExtractor(`claim_data/baseline_output.json`, `claim_data/baseline_element_eval_input.json`, google("gemini-2.5-flash-preview-04-17"))

baselineCoverageEvaluator(`claim_data/baseline_element_eval_input.json`, `claim_data/baseline_element_eval_output.json`, google("gemini-2.5-flash-preview-04-17"));