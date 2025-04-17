declare module "@buger/probe" {
  /**
   * Search function from @buger/probe
   * @param options Search options
   * @returns Search results
   */
  export function search(options: {
    path: string;
    query: string;
    maxTokens?: number;
    skipTokens?: number;
    semanticSearch?: boolean;
    fuzzyMatch?: boolean;
    includeCodeSnippets?: boolean;
    [key: string]: any;
  }): Promise<string>;
}
