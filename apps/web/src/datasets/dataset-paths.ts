export function datasetPagePath(datasetName: string): string {
  return `/datasets/${encodeURIComponent(datasetName)}`;
}

/** Outside `/test-cases/`, so that a Test Case may be named "new". */
export function newTestCasePath(datasetName: string): string {
  return `${datasetPagePath(datasetName)}/new-test-case`;
}

export function testCaseEditorPath(datasetName: string, testCaseName: string): string {
  return `${datasetPagePath(datasetName)}/test-cases/${encodeURIComponent(testCaseName)}`;
}
