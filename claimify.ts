
import { createContext, filterVerifiableInformation, unsafe_createContext } from "./deterministic/claimify"
import { generateText, generateObject } from "ai";
import { SELECTION_SYSTEM, SELECTION_USER, DISAMB_SYSTEM, DISAMB_USER, DECOMP_SYS, DECOMP_USER, EVAL_ENTAILMENT_SYS, EVAL_ENTAILMENT_USER, EVAL_CREATE_ELEMENTS_SYS, EVAL_CREATE_ELEMENTS_USER, EVAL_ELEMENT_COVERAGE_SYS, EVAL_ELEMENT_COVERAGE_USER } from "./prompts/claimify";
import { LanguageModelV1 } from "ai";
import { readFileSync, writeFileSync } from "fs"
import { google } from '@ai-sdk/google';
import { anthropic } from "@ai-sdk/anthropic";
import dotenv from "dotenv"
import { SelectionOutput, DecompositionData, SelectionOutputSchema, DataItemWithExcerpts, SentenceData, DisambiguationOutput, DisambiguationOutputSchema, DisambiguationData, DecompositionOutput, DecompositionOutputSchema } from "./types/claimify"
import { z } from "zod"

dotenv.config();
// Schema for individual elements
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



// Main schema for element extraction output
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

interface ElementCoverageData {
    query: string
    excerpt: string
    sentence: string
    elementExtraction: ElementExtractionOutput | string // Could be error string
    claims: string[]
}

async function claimifySelection(inputFilePath: string, outputJsonFilePath: string, model: LanguageModelV1): Promise<void> {
    console.log(`\n--- Starting Claimify Selection Step ---`)
    console.log(`Reading data from: ${inputFilePath}`)
    console.log(`Saving LLM outputs to: ${outputJsonFilePath}`)

    try {
        const rawData = readFileSync(inputFilePath, "utf-8")
        const data: DataItemWithExcerpts[] = JSON.parse(rawData)

        if (!Array.isArray(data)) {
            console.error(`Error: Expected input JSON to be an array, but got ${typeof data}.`)
            return
        }

        // This will be the final array of arrays
        const finalGroupedOutput: z.infer<typeof SelectionOutputSchema>[][] = []
        let processedItemsCount = 0

        for (const item of data) {
            const { query, tokenized_response, excerpts, filename } = item

            if (!tokenized_response || !Array.isArray(tokenized_response) || !excerpts || !Array.isArray(excerpts)) {
                console.warn(
                    `Warning: Item '${filename}' missing 'tokenized_response' or 'excerpts' arrays. Skipping LLM calls for this item.`,
                )
                continue
            }

            if (tokenized_response.length !== excerpts.length) {
                console.warn(
                    `Warning: Mismatch in lengths of 'tokenized_response' (${tokenized_response.length}) and 'excerpts' (${excerpts.length}) for item '${filename}'. Skipping LLM calls for this item.`,
                )
                continue
            }

            console.log(`\nProcessing item: ${filename} (Query: "${query.substring(0, 50)}...")`)

            const currentFileSelectionOutputs: z.infer<typeof SelectionOutputSchema>[] = [] // Collect outputs for the current file's sentences
            for (let i = 0; i < tokenized_response.length; i++) {
                const sentence = tokenized_response[i]
                const excerpt = excerpts[i]

                console.log(
                    `  - Calling LLM for sentence ${i + 1}/${tokenized_response.length}: "${sentence.substring(0, 70)}..."`,
                )

                try {
                    const { object: llmRawOutput } = await generateObject({
                        model: model,
                        schema: SelectionOutputSchema, // LLM returns only these fields
                        system: SELECTION_SYSTEM,
                        prompt: SELECTION_USER(query, excerpt, sentence),
                    })

                    currentFileSelectionOutputs.push(llmRawOutput) // Just push the raw LLM output
                } catch (llmError) {
                    console.error(`    Error calling LLM for sentence ${i + 1} in ${filename}:`, llmError)
                    // Add deterministic metadata even on error
                    const errorOutput: SelectionOutput = {
                        filename: filename,
                        originalSentenceIndex: i,
                        sentence: sentence, // Original sentence
                        finalSubmission: "Does NOT contain a specific and verifiable proposition", // Default to "No" on error
                        sentenceWithOnlyVerifiableInformation: `ERROR: ${llmError}`,
                    }
                    // currentFileSelectionOutputs.push(errorOutput) // Commented out because type is now z.infer<typeof SelectionOutputSchema>
                }
            }
            finalGroupedOutput.push(currentFileSelectionOutputs) // Add the array of outputs for this file
            processedItemsCount++
        }

        // Write the array of arrays to a JSON file
        writeFileSync(outputJsonFilePath, JSON.stringify(finalGroupedOutput, null, 2), "utf-8")
        console.log(
            `\nSuccessfully processed ${processedItemsCount} items. All LLM outputs saved to '${outputJsonFilePath}'`,
        )
    } catch (error) {
        if (error instanceof Error) {
            console.error(`Error during Selection Step: ${error.message}`)
        } else {
            console.error(`An unknown error occurred during Selection Step: ${error}`)
        }
        throw error // Re-throw to indicate failure
    }
}


async function claimifyDisambiguiation(
    inputFilePath: string,
    outputJsonFilePath: string,
    model: LanguageModelV1,
): Promise<void> {
    console.log(`\n--- Starting Claimify Disambiguation Step ---`)
    console.log(`Reading data from: ${inputFilePath}`)
    console.log(`Saving LLM outputs to: ${outputJsonFilePath}`)

    try {
        const rawData = readFileSync(inputFilePath, "utf-8")
        const data: (SentenceData | {})[][] = JSON.parse(rawData)

        if (!Array.isArray(data)) {
            console.error(`Error: Expected input JSON to be an array, but got ${typeof data}.`)
            return
        }

        // This will be the final array of arrays
        const finalGroupedOutput: (DisambiguationOutput | {})[][] = []
        let processedDocumentsCount = 0

        for (let docIndex = 0; docIndex < data.length; docIndex++) {
            const documentSentences = data[docIndex]
            console.log(`\nProcessing document ${docIndex + 1}/${data.length}`)

            const currentDocumentOutputs: (DisambiguationOutput | {})[] = []

            for (let sentenceIndex = 0; sentenceIndex < documentSentences.length; sentenceIndex++) {
                const sentenceItem = documentSentences[sentenceIndex]

                // Check if it's an empty object (pruned sentence)
                if (Object.keys(sentenceItem).length === 0) {
                    console.log(`  - Skipping empty object at sentence ${sentenceIndex + 1}`)
                    currentDocumentOutputs.push({}) // Add empty object to result
                    continue
                }

                const sentenceData = sentenceItem as SentenceData
                const { query, excerpt, sentence, sentenceWithOnlyVerifiableInformation } = sentenceData

                // Determine which sentence to use for the LLM prompt
                const sentenceForPrompt =
                    sentenceWithOnlyVerifiableInformation === "remains unchanged"
                        ? sentence
                        : sentenceWithOnlyVerifiableInformation

                console.log(
                    `  - Calling LLM for sentence ${sentenceIndex + 1}/${documentSentences.length}: "${sentenceForPrompt.substring(0, 70)}..."`,
                )

                try {
                    const { object: llmOutput } = await generateObject({
                        model: model,
                        schema: DisambiguationOutputSchema,
                        system: DISAMB_SYSTEM,
                        prompt: DISAMB_USER(query, excerpt, sentenceForPrompt),
                    })

                    currentDocumentOutputs.push({
                        ...llmOutput,
                        originalSentence: sentenceForPrompt,
                        query: query,
                        excerpt: excerpt,
                    })
                } catch (llmError) {
                    console.error(`    Error calling LLM for sentence ${sentenceIndex + 1} in document ${docIndex}:`, llmError)

                    // Add error result with the expected schema structure
                    const errorOutput: DisambiguationOutput = {
                        incompleteNamesAnalysis: `ERROR: ${llmError}`,
                        linguisticAmbiguityAnalysis: `ERROR: ${llmError}`,
                        canBeDisambiguated: false,
                        changesNeeded: `ERROR: ${llmError}`,
                        decontextualizedSentence: `ERROR: ${llmError}`,
                    }
                    currentDocumentOutputs.push({
                        ...errorOutput,
                        originalSentence: sentenceForPrompt,
                        query: query,
                        excerpt: excerpt,
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
            console.error(`Error during Disambiguation Step: ${error.message}`)
        } else {
            console.error(`An unknown error occurred during Disambiguation Step: ${error}`)
        }
        throw error // Re-throw to indicate failure
    }
}

async function claimifyDecomposition(
    inputFilePath: string,
    outputJsonFilePath: string,
    model: LanguageModelV1,
): Promise<void> {
    console.log(`\n--- Starting Claimify Decomposition Step ---`)
    console.log(`Reading data from: ${inputFilePath}`)
    console.log(`Saving LLM outputs to: ${outputJsonFilePath}`)

    try {
        const rawData = readFileSync(inputFilePath, "utf-8")
        const data: (DisambiguationData | {})[][] = JSON.parse(rawData)

        if (!Array.isArray(data)) {
            console.error(`Error: Expected input JSON to be an array, but got ${typeof data}.`)
            return
        }

        // This will be the final array of arrays
        const finalGroupedOutput: (DecompositionOutput | {})[][] = []
        let processedDocumentsCount = 0

        for (let docIndex = 0; docIndex < data.length; docIndex++) {
            const documentSentences = data[docIndex]
            console.log(`\nProcessing document ${docIndex + 1}/${data.length}`)

            const currentDocumentOutputs: (DecompositionOutput | {})[] = []

            for (let sentenceIndex = 0; sentenceIndex < documentSentences.length; sentenceIndex++) {
                const sentenceItem = documentSentences[sentenceIndex]

                // Check if it's an empty object (pruned sentence)
                if (Object.keys(sentenceItem).length === 0) {
                    console.log(`  - Skipping empty object at sentence ${sentenceIndex + 1}`)
                    currentDocumentOutputs.push({}) // Add empty object to result
                    continue
                }

                const disambiguationData = sentenceItem as DisambiguationData
                const { query, excerpt, canBeDisambiguated, decontextualizedSentence } = disambiguationData

                // Check if sentence cannot be disambiguated
                if (!canBeDisambiguated) {
                    console.log(`  - Skipping sentence ${sentenceIndex + 1} (cannot be disambiguated)`)
                    currentDocumentOutputs.push({}) // Add empty object to result
                    continue
                }

                console.log(
                    `  - Calling LLM for sentence ${sentenceIndex + 1}/${documentSentences.length}: "${decontextualizedSentence.substring(0, 70)}..."`,
                )

                try {
                    const { object: llmOutput } = await generateObject({
                        model: model,
                        schema: DecompositionOutputSchema,
                        system: DECOMP_SYS,
                        prompt: DECOMP_USER(query, excerpt, decontextualizedSentence),
                    })

                    currentDocumentOutputs.push({
                        ...llmOutput,
                        query,
                        excerpt,
                    })
                } catch (llmError) {
                    console.error(`    Error calling LLM for sentence ${sentenceIndex + 1} in document ${docIndex}:`, llmError)

                    // Add error result with the expected schema structure
                    const errorOutput: DecompositionOutput = {
                        sentence: decontextualizedSentence,
                        referentialTermsAnalysis: `ERROR: ${llmError}`,
                        maxClarifiedSentence: `ERROR: ${llmError}`,
                        propositionRange: `ERROR: ${llmError}`,
                        specificVerifiablePropositions: [],
                        propositionsWithContext: [],
                    }
                    currentDocumentOutputs.push({ ...errorOutput, query, excerpt })
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
            console.error(`Error during Decomposition Step: ${error.message}`)
        } else {
            console.error(`An unknown error occurred during Decomposition Step: ${error}`)
        }
        throw error // Re-throw to indicate failure
    }
}

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
async function entailmentEvaluator(
    inputFilePath: string,
    outputJsonFilePath: string,
    model: LanguageModelV1,
): Promise<void> {
    console.log(`\n--- Starting Claimify Entailment Evaluation Step ---`)
    console.log(`Reading data from: ${inputFilePath}`)
    console.log(`Saving LLM outputs to: ${outputJsonFilePath}`)

    try {
        const rawData = readFileSync(inputFilePath, "utf-8")
        const data: (DecompositionData | {})[][] = JSON.parse(rawData)

        if (!Array.isArray(data)) {
            console.error(`Error: Expected input JSON to be an array, but got ${typeof data}.`)
            return
        }

        // This will be the final array of arrays
        const finalGroupedOutput: any[][] = []
        let processedDocumentsCount = 0

        for (let docIndex = 0; docIndex < data.length; docIndex++) {
            const documentSentences = data[docIndex]
            console.log(`\nProcessing document ${docIndex + 1}/${data.length}`)

            const currentDocumentOutputs: any[] = []

            for (let sentenceIndex = 0; sentenceIndex < documentSentences.length; sentenceIndex++) {
                const sentenceItem = documentSentences[sentenceIndex]

                // Check if it's an empty object (pruned sentence)
                if (Object.keys(sentenceItem).length === 0) {
                    console.log(`  - Skipping empty object at sentence ${sentenceIndex + 1}`)
                    currentDocumentOutputs.push({}) // Add empty object to result
                    continue
                }

                const decompositionData = sentenceItem as DecompositionData
                const { query, excerpt, sentence, propositionsWithContext } = decompositionData

                console.log(
                    `\nProcessing sentence ${sentenceIndex + 1}/${documentSentences.length}: "${sentence.substring(0, 70)}..."`,
                )
                console.log(`  - Found ${propositionsWithContext.length} claims to evaluate`)

                const claimEvaluations: any[] = []

                // Loop through each claim in propositionsWithContext
                for (let claimIndex = 0; claimIndex < propositionsWithContext.length; claimIndex++) {
                    const claim = propositionsWithContext[claimIndex]

                    console.log(
                        `    - Evaluating claim ${claimIndex + 1}/${propositionsWithContext.length}: "${claim.substring(0, 50)}..."`,
                    )

                    try {
                        const { object: llmResponse } = await generateObject({
                            model: model,
                            schema: EntailmentOutputSchema,
                            system: EVAL_ENTAILMENT_SYS,
                            prompt: EVAL_ENTAILMENT_USER(query, excerpt, sentence, claim),
                        })
                        claimEvaluations.push({
                            claim: claim,
                            entailmentEvaluation: llmResponse,
                        })
                    } catch (llmError) {
                        console.error(
                            `      Error calling LLM for claim ${claimIndex + 1} in sentence ${sentenceIndex + 1}:`,
                            llmError,
                        )

                        // Add error result
                        claimEvaluations.push({
                            claim: claim,
                            entailmentEvaluation: `ERROR: ${llmError}`,
                        })
                    }
                }

                // Add the sentence data with all its claim evaluations
                currentDocumentOutputs.push({
                    //...decompositionData,
                    claimEvaluations: claimEvaluations,
                })
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
            console.error(`Error during Entailment Evaluation Step: ${error.message}`)
        } else {
            console.error(`An unknown error occurred during Entailment Evaluation Step: ${error}`)
        }
        throw error // Re-throw to indicate failure
    }
}

async function elementExtractorV2(
    inputFilePath: string,
    outputJsonFilePath: string,
    model: LanguageModelV1,
): Promise<void> {
    console.log(`\n--- Starting Element Extraction Step (v2 with structured output) ---`)
    console.log(`Reading data from: ${inputFilePath}`)
    console.log(`Saving LLM outputs to: ${outputJsonFilePath}`)

    try {
        const rawData = readFileSync(inputFilePath, "utf-8")
        const data: (DecompositionData | {})[][] = JSON.parse(rawData)

        if (!Array.isArray(data)) {
            console.error(`Error: Expected input JSON to be an array, but got ${typeof data}.`)
            return
        }

        // This will be the final array of arrays
        const finalGroupedOutput: any[][] = []
        let processedDocumentsCount = 0

        for (let docIndex = 0; docIndex < data.length; docIndex++) {
            const documentSentences = data[docIndex]
            console.log(`\nProcessing document ${docIndex + 1}/${data.length}`)

            const currentDocumentOutputs: any[] = []

            for (let sentenceIndex = 0; sentenceIndex < documentSentences.length; sentenceIndex++) {
                const sentenceItem = documentSentences[sentenceIndex]

                // Check if it's an empty object (pruned sentence)
                if (Object.keys(sentenceItem).length === 0) {
                    console.log(`  - Skipping empty object at sentence ${sentenceIndex + 1}`)
                    currentDocumentOutputs.push({}) // Add empty object to result
                    continue
                }

                const decompositionData = sentenceItem as DecompositionData
                const { query, excerpt, sentence, propositionsWithContext } = decompositionData

                console.log(
                    `\nProcessing sentence ${sentenceIndex + 1}/${documentSentences.length}: "${sentence.substring(0, 70)}..."`,
                )

                try {
                    const { object: llmResponse } = await generateObject({
                        model: model,
                        schema: ElementExtractionSchema,
                        system: EVAL_CREATE_ELEMENTS_SYS,
                        prompt: EVAL_CREATE_ELEMENTS_USER(query, excerpt, sentence),
                    })

                    // Add the sentence data with the extracted elements
                    currentDocumentOutputs.push({
                        query: query,
                        excerpt: excerpt,
                        sentence: sentence,
                        elementExtraction: llmResponse,
                        claims: propositionsWithContext,
                    })

                    console.log(
                        `    - Successfully extracted ${llmResponse.elements.length} elements for sentence ${sentenceIndex + 1}`,
                    )
                } catch (llmError) {
                    console.error(`      Error calling LLM for sentence ${sentenceIndex + 1}:`, llmError)

                    // Add error result
                    currentDocumentOutputs.push({
                        query: query,
                        excerpt: excerpt,
                        sentence: sentence,
                        claims: propositionsWithContext,

                        elementExtraction: `ERROR: ${llmError}`,
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
            console.error(`Error during Element Extraction Step: ${error.message}`)
        } else {
            console.error(`An unknown error occurred during Element Extraction Step: ${error}`)
        }
        throw error // Re-throw to indicate failure
    }
}
const ElementCoverageItemSchema = z.object({
    element: z.string().describe("The element being evaluated"),
    coverageStatus: z
        .enum([
            "fully covered by C",
            "partially covered by C",
            "not covered by C",
            "not verifiable - correctly not covered by C",
            "not verifiable - incorrectly covered by C",
        ])
        .describe("Whether and how the element is covered by the claims"),
    reasoning: z.string().optional().describe("Optional reasoning for the coverage decision"),
})

// Main schema for element coverage evaluation output
export const ElementCoverageEvaluationSchema = z.object({
    elementCoverageResults: z.array(ElementCoverageItemSchema).describe("Coverage evaluation for each element"),

    overallSummary: z.string().describe("Overall summary of the coverage evaluation"),

    metrics: z
        .object({
            truePositives: z.number().describe("Number of verifiable elements correctly covered"),
            falseNegatives: z.number().describe("Number of verifiable elements not covered"),
            falsePositives: z.number().describe("Number of non-verifiable elements incorrectly covered"),
            trueNegatives: z.number().describe("Number of non-verifiable elements correctly not covered"),
        })
        .describe("Coverage metrics"),
})

export type ElementCoverageEvaluationOutput = z.infer<typeof ElementCoverageEvaluationSchema>

async function elementCoverageEvaluatorV2(
    inputFilePath: string,
    outputJsonFilePath: string,
    model: LanguageModelV1,
): Promise<void> {
    console.log(`\n--- Starting Element Coverage Evaluation Step (v2 with structured output) ---`)
    console.log(`Reading data from: ${inputFilePath}`)
    console.log(`Saving LLM outputs to: ${outputJsonFilePath}`)

    try {
        const rawData = readFileSync(inputFilePath, "utf-8")
        const data: (ElementCoverageData | {})[][] = JSON.parse(rawData)

        if (!Array.isArray(data)) {
            console.error(`Error: Expected input JSON to be an array, but got ${typeof data}.`)
            return
        }

        // This will be the final array of arrays
        const finalGroupedOutput: any[][] = []
        let processedDocumentsCount = 0

        for (let docIndex = 0; docIndex < data.length; docIndex++) {
            const documentSentences = data[docIndex]
            console.log(`\nProcessing document ${docIndex + 1}/${data.length}`)

            const currentDocumentOutputs: any[] = []

            for (let sentenceIndex = 0; sentenceIndex < documentSentences.length; sentenceIndex++) {
                const sentenceItem = documentSentences[sentenceIndex]

                // Check if it's an empty object (pruned sentence)
                if (Object.keys(sentenceItem).length === 0) {
                    console.log(`  - Skipping empty object at sentence ${sentenceIndex + 1}`)
                    currentDocumentOutputs.push({}) // Add empty object to result
                    continue
                }

                const elementData = sentenceItem as ElementCoverageData
                const { query, excerpt, sentence, elementExtraction, claims } = elementData

                // Skip if element extraction failed
                if (typeof elementExtraction === "string") {
                    console.log(`  - Skipping sentence ${sentenceIndex + 1} due to element extraction error`)
                    currentDocumentOutputs.push({
                        ...elementData,
                        coverageEvaluation: `SKIPPED: Element extraction failed - ${elementExtraction}`,
                    })
                    continue
                }

                console.log(
                    `\nProcessing sentence ${sentenceIndex + 1}/${documentSentences.length}: "${sentence.substring(0, 70)}..."`,
                )
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

                    // Add the sentence data with structured coverage evaluation
                    currentDocumentOutputs.push({
                        query: query,
                        excerpt: excerpt,
                        sentence: sentence,
                        elementExtraction: elementExtraction,
                        claims: claims,
                        coverageEvaluation: llmResponse,
                    })

                    console.log(
                        `    - Successfully evaluated coverage for sentence ${sentenceIndex + 1}: TP=${llmResponse.metrics.truePositives}, FN=${llmResponse.metrics.falseNegatives}, FP=${llmResponse.metrics.falsePositives}, TN=${llmResponse.metrics.trueNegatives}`,
                    )
                } catch (llmError) {
                    console.error(`      Error calling LLM for sentence ${sentenceIndex + 1}:`, llmError)

                    // Add error result
                    currentDocumentOutputs.push({
                        query: query,
                        excerpt: excerpt,
                        sentence: sentence,
                        elementExtraction: elementExtraction,
                        claims: claims,
                        coverageEvaluation: `ERROR: ${llmError}`,
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
            console.error(`Error during Element Coverage Evaluation Step: ${error.message}`)
        } else {
            console.error(`An unknown error occurred during Element Coverage Evaluation Step: ${error}`)
        }
        throw error // Re-throw to indicate failure
    }
}
async function main() {
    const input = `claim_data/data_with_context_single.json`;
    const output = `claim_data/output_single_2.json`;

    //Firstly, we generate excerpts for tokenized data with p and f  aka CREATE CONTEXT
    createContext(`claim_data/bingCheck_tokenized_truncated.json`, `claim_data/selection_input.json`, 5, 5);

    // Secondly, we enter the SELECTION STAGE
    await claimifySelection(`claim_data/selection_input.json`, `claim_data/selection_output.json`, google("gemini-2.5-flash-preview-04-17"));


    // We prune unverifiable claims from the the selection stage, this can be done inside claimifySelection for cleaner code

    filterVerifiableInformation(`claim_data/selection_output.json`, `claim_data/selection_output_pruned.json`);

    // For the disambiguation and decomposition stages, we keep p = 5, but we do f = 0

    unsafe_createContext(`claim_data/selection_output_pruned.json`, `claim_data/bingCheck_tokenized_truncated.json`, `claim_data/disambiguiation_input.json`, 5, 0);

    await claimifyDisambiguiation(`claim_data/disambiguiation_input.json`, `claim_data/disambiguiation_output.json`, google("gemini-2.5-flash-preview-04-17"));

    // verify if the output of Disambiguiation directly feeds into Decomp without further deterministic steps?

    await claimifyDecomposition(`claim_data/disambiguiation_output.json`, `claim_data/decomposition_output.json`, google("gemini-2.5-flash-preview-04-17"));

    // await entailmentEvaluator(`claim_data/decomposition_output.json`, `claim_data/entailment_evalation.json`, google("gemini-2.5-flash-preview-04-17"));

    // await elementExtractorV2(`claim_data/decomposition_output.json`, `claim_data/extracted_elements.json`, google("gemini-2.5-flash-preview-04-17"));

    // await elementCoverageEvaluatorV2(`claim_data/extracted_elements.json`, `claim_data/evaluated_elements_cvg.json`, google("gemini-2.5-flash-preview-04-17"));
}

async function evaluate() {
    // await elementExtractorV2(`claim_data/claimify_final_output.json`, `claim_data/extracted_elements.json`, google("gemini-2.5-flash-preview-04-17"));


    await elementCoverageEvaluatorV2(`claim_data/extracted_elements.json`, `claim_data/claimify_element_val_output.json`, google("gemini-2.5-flash-preview-04-17"));


}

evaluate();