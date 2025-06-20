import { readFileSync, writeFileSync } from "fs"
import { join } from "path"
import type { ProcessedDataItem, DataItemWithExcerpts, SentenceData, OriginalDocument, SentenceWithExcerpt, DecompositionData } from "../types/claimify";
interface SentenceCoverageData {
    sentence: string
    maxClarifiedSentence: string
}
/**
 * Adds EXCERPTS with p and f before the 
 */
function createExcerpt(allSentences: string[], targetIndex: number, p: number, f: number): string {
    const numSentences = allSentences.length

    // Calculate actual preceding sentences count, respecting bounds
    const actualP = Math.min(p, targetIndex)
    const precedingSentences = allSentences.slice(targetIndex - actualP, targetIndex)

    // Calculate actual following sentences count, respecting bounds
    const actualF = Math.min(f, numSentences - 1 - targetIndex)
    const followingSentences = allSentences.slice(targetIndex + 1, targetIndex + 1 + actualF)

    const contextParts = [
        ...precedingSentences,
        allSentences[targetIndex], // The target sentence itself
        ...followingSentences,
    ]

    return contextParts.join(" ")
}


export function createContext(inputFileName: string, outputFileName: string, p: number, f: number): void {
    const inputPath = join(process.cwd(), inputFileName)
    const outputPath = join(process.cwd(), outputFileName)

    try {
        const rawData = readFileSync(inputPath, "utf-8")
        const data: ProcessedDataItem[] = JSON.parse(rawData)

        if (!Array.isArray(data)) {
            console.error(`Error: Expected input JSON to be an array, but got ${typeof data}.`)
            return
        }

        const dataWithExcerpts: DataItemWithExcerpts[] = data.map((item) => {
            const excerpts: string[] = []
            if (item.tokenized_response && Array.isArray(item.tokenized_response)) {
                item.tokenized_response.forEach((_, index) => {
                    const excerpt = createExcerpt(item.tokenized_response, index, p, f)
                    excerpts.push(excerpt)
                })
            } else {
                console.warn(
                    `Warning: Item '${item.filename}' missing 'tokenized_response' or it's not an array. Excerpts will be empty.`,
                )
            }
            return { ...item, excerpts }
        })

        writeFileSync(outputPath, JSON.stringify(dataWithExcerpts, null, 2), "utf-8")
        console.log(`Successfully created excerpts and saved to '${outputPath}'`)
    } catch (error) {
        if (error instanceof Error) {
            console.error(`Error processing data: ${error.message}`)
        } else {
            console.error(`An unknown error occurred: ${error}`)
        }
    }
}


export function filterVerifiableInformation(inputFilePath: string, outputFilePath: string): void {
    try {
        // Read the input file content
        const fileContent = readFileSync(inputFilePath, "utf-8")
        const data: SentenceData[][] = JSON.parse(fileContent)

        // Process the data: replace filtered items with empty objects
        const filteredData = data.map((innerArray) => {
            return innerArray.map((item) => {
                if (item.sentenceWithOnlyVerifiableInformation === "None") {
                    return {} // Replace with an empty object
                }
                return item
            })
        })

        // Write the filtered data to the output file
        writeFileSync(outputFilePath, JSON.stringify(filteredData, null, 2), "utf-8")
        console.log(`Filtered data successfully written to ${outputFilePath}`)
    } catch (error) {
        console.error(`Error processing file: ${error}`)
        throw error // Re-throw to indicate failure
    }
}












function createExcerpt_pog(allSentences: string[], targetIndex: number, p: number, f: number): string {
    const numSentences = allSentences.length

    // Calculate actual preceding sentences count, respecting bounds
    const actualP = Math.min(p, targetIndex)
    const precedingSentences = allSentences.slice(targetIndex - actualP, targetIndex)

    // Calculate actual following sentences count, respecting bounds
    const actualF = Math.min(f, numSentences - 1 - targetIndex)
    const followingSentences = allSentences.slice(targetIndex + 1, targetIndex + 1 + actualF)

    const contextParts = [
        ...precedingSentences,
        allSentences[targetIndex], // The target sentence itself
        ...followingSentences,
    ]

    return contextParts.join(" ")
}

/**
 * Reads filtered selection data and original document data, then adds excerpts
 * to each sentence object in the filtered data based on index mapping.
 *
 * @param filteredSelectionFilePath Path to the JSON file containing filtered selection results with empty objects as placeholders.
 * @param originalDocumentsFilePath Path to the JSON file containing original documents with tokenized responses.
 * @param outputFilePath Path where the processed data with excerpts will be written.
 * @param p Number of preceding sentences for the excerpt.
 * @param f Number of following sentences for the excerpt.
 */
export function unsafe_createContext(
    filteredSelectionFilePath: string,
    originalDocumentsFilePath: string,
    outputFilePath: string,
    p: number,
    f: number,
): void {
    try {
        // Read filtered selection data
        const rawFilteredData = readFileSync(filteredSelectionFilePath, "utf-8")
        const filteredData: (SentenceData | {})[][] = JSON.parse(rawFilteredData)

        // Read original documents data
        const rawOriginalData = readFileSync(originalDocumentsFilePath, "utf-8")
        const originalDocuments: OriginalDocument[] = JSON.parse(rawOriginalData)

        if (!Array.isArray(filteredData) || !Array.isArray(originalDocuments)) {
            console.error("Error: Input JSON files must contain arrays.")
            return
        }

        if (filteredData.length !== originalDocuments.length) {
            console.warn(
                "Warning: Mismatch in the number of documents between filtered selection data and original documents. Processing might be inaccurate.",
            )
        }

        const dataWithExcerpts = filteredData.map((docFilteredSentences, docIndex) => {
            const originalDoc = originalDocuments[docIndex]

            if (!originalDoc || !originalDoc.tokenized_response) {
                console.warn(
                    `Warning: Original document at index ${docIndex} is missing or does not have 'tokenized_response'. Skipping excerpt generation for this document's filtered sentences.`,
                )
                return docFilteredSentences.map((item) => {
                    if (Object.keys(item).length === 0) {
                        return {} // Keep empty objects as empty
                    }
                    return { ...item, excerpt: "" }
                })
            }

            return docFilteredSentences.map((filteredItem, sentenceIndex) => {
                // If it's an empty object, keep it as empty
                if (Object.keys(filteredItem).length === 0) {
                    return {}
                }

                const filteredSentence = filteredItem as SentenceData
                const tokenizedResponse = originalDoc.tokenized_response

                // Use the current index directly - no need to search!
                const excerpt = createExcerpt(tokenizedResponse, sentenceIndex, p, f)

                return {
                    ...filteredSentence,
                    query: originalDoc.query,  // Add this line
                    excerpt: excerpt,
                } as SentenceWithExcerpt
            })
        })

        writeFileSync(outputFilePath, JSON.stringify(dataWithExcerpts, null, 2), "utf-8")
        console.log(`Successfully added excerpts and saved to '${outputFilePath}'`)
    } catch (error) {
        if (error instanceof Error) {
            console.error(`Error processing data: ${error.message}`)
        } else {
            console.error(`An unknown error occurred: ${error}`)
        }
    }
}








export function extractSentenceCoverageData(inputFilePath: string, outputFilePath: string): void {
    console.log(`\n--- Extracting Sentence Coverage Data ---`)
    console.log(`Reading data from: ${inputFilePath}`)
    console.log(`Saving extracted data to: ${outputFilePath}`)

    try {
        const rawData = readFileSync(inputFilePath, "utf-8")
        const data: (DecompositionData | {})[][] = JSON.parse(rawData)

        if (!Array.isArray(data)) {
            console.error(`Error: Expected input JSON to be an array, but got ${typeof data}.`)
            return
        }

        // Process the data while preserving structure
        const extractedData: (SentenceCoverageData | {})[][] = data.map((documentSentences, docIndex) => {
            console.log(`Processing document ${docIndex + 1}/${data.length}`)

            return documentSentences.map((sentenceItem, sentenceIndex) => {
                // Check if it's an empty object (pruned sentence)
                if (Object.keys(sentenceItem).length === 0) {
                    return {} // Keep empty objects as empty
                }

                const decompositionData = sentenceItem as DecompositionData

                // Extract only sentence and maxClarifiedSentence
                return {
                    sentence: decompositionData.sentence,
                    maxClarifiedSentence: decompositionData.maxClarifiedSentence,
                } as SentenceCoverageData
            })
        })

        // Write the extracted data to the output file
        writeFileSync(outputFilePath, JSON.stringify(extractedData, null, 2), "utf-8")

        const totalDocuments = extractedData.length
        const totalSentences = extractedData.reduce((sum, doc) => sum + doc.length, 0)
        const nonEmptySentences = extractedData.reduce(
            (sum, doc) => sum + doc.filter((item) => Object.keys(item).length > 0).length,
            0,
        )

        console.log(`\nSuccessfully extracted sentence coverage data:`)
        console.log(`- Total documents: ${totalDocuments}`)
        console.log(`- Total sentence positions: ${totalSentences}`)
        console.log(`- Non-empty sentences: ${nonEmptySentences}`)
        console.log(`- Empty objects preserved: ${totalSentences - nonEmptySentences}`)
        console.log(`Data saved to '${outputFilePath}'`)
    } catch (error) {
        if (error instanceof Error) {
            console.error(`Error extracting sentence coverage data: ${error.message}`)
        } else {
            console.error(`An unknown error occurred during sentence coverage extraction: ${error}`)
        }
        throw error // Re-throw to indicate failure
    }
}