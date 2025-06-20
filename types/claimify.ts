
import { z } from "zod"


export type Sentence = {
    id: string
    text: string
    originalIndex: number
}

export type SentenceWithContext = Sentence & {
    context: string
    precedingSentences: Sentence[]
    followingSentences: Sentence[]
}

export type QuestionAnswerPair = {
    query: string
    response: string
}

export type ExtractedClaim = {
    id: string
    text: string
    sourceSentenceId: string
    // Additional properties will be added as we implement more stages
}

// New type for the input data after Python preprocessing
export type ProcessedDataItem = {
    filename: string
    query: string
    response: string
    tokenized_response: string[] // Array of tokenized sentences
}

// New type for the output data after TypeScript context creation
export type DataItemWithExcerpts = ProcessedDataItem & {
    excerpts: string[] // Array of excerpts, matching tokenized_response index
}


export const SelectionOutputSchema = z.object({
    // New field to store the original sentence
    sentence: z.string().describe("The original sentence unchanged"),
    finalSubmission: z.union([
        z.literal("Contains a specific and verifiable proposition"),
        z.literal("Does NOT contain a specific and verifiable proposition"),
    ]).describe(`"Contains a specific and verifiable proposition"  or "Does NOT contain a
specific and verifiable proposition"`),
    // This will capture "remains unchanged", "None", or the modified sentence
    sentenceWithOnlyVerifiableInformation: z.string().describe(`Insert the changed sentence OR  "Remains Unchanged" if no changes OR 'None' if the sentence does NOT contain a specific and verifiable preposition.`)
})

// TypeScript type inferred from the Zod schema
export type SelectionOutput = z.infer<typeof SelectionOutputSchema> & {
    filename: string // Added by our code
    originalSentenceIndex: number // Added by our code
}



export interface OriginalDocument {
    filename: string
    query: string
    response: string
    tokenized_response: string[]
}


export interface DisambiguationData {
    incompleteNamesAnalysis: string
    linguisticAmbiguityAnalysis: string
    canBeDisambiguated: boolean
    changesNeeded: string
    decontextualizedSentence: string
    originalSentence: string
    query: string
    excerpt: string
}
export interface SentenceData {
    sentence: string
    finalSubmission: string
    sentenceWithOnlyVerifiableInformation: string
    query: string
    excerpt: string
}

export interface SentenceWithExcerpt extends SentenceData {
    excerpt: string
    query: string
}

export const DisambiguationOutputSchema = z.object({
    incompleteNamesAnalysis: z
        .string()
        .describe("Analysis of partial names, acronyms, and abbreviations in the sentence"),
    linguisticAmbiguityAnalysis: z.string().describe("Analysis of referential and structural ambiguity in the sentence"),
    canBeDisambiguated: z
        .boolean()
        .describe("Whether readers would likely reach consensus on the correct interpretation"),
    changesNeeded: z.string().describe("List of changes needed to decontextualize the sentence"),
    decontextualizedSentence: z.string().describe("The final decontextualized sentence or 'Cannot be decontextualized'"),
})
export const DecompositionOutputSchema = z.object({
    sentence: z.string().describe("The original sentence being decomposed"),
    referentialTermsAnalysis: z.string().describe("Analysis of referential terms that need clarification"),
    maxClarifiedSentence: z.string().describe("Sentence with discrete units of information and clarified referents"),
    propositionRange: z.string().describe("Range of possible number of propositions (e.g., '3 - 4')"),
    specificVerifiablePropositions: z
        .array(z.string())
        .describe("Array of specific, verifiable, and decontextualized propositions"),
    propositionsWithContext: z
        .array(z.string())
        .describe("Array of propositions with essential context/clarifications and 'true or false?' format"),
})
export interface DecompositionData {
    sentence: string
    referentialTermsAnalysis: string
    maxClarifiedSentence: string
    propositionRange: string
    specificVerifiablePropositions: string[]
    propositionsWithContext: string[]
    query: string
    excerpt: string
}
export type DecompositionOutput = z.infer<typeof DecompositionOutputSchema>
export type DisambiguationOutput = z.infer<typeof DisambiguationOutputSchema>