import {
  type DirectoryImportProblem,
  type DirectoryImportUser,
  directoryImportUserSchema,
  MAXIMUM_DIRECTORY_IMPORT_ROWS,
} from "@extispex/contracts";
import { parse as parseCsv } from "@std/csv";
import type { DirectoryImportRow } from "../storage/mod.ts";

export type ParsedDirectoryFile =
  | { status: "parsed"; rows: DirectoryImportRow[] }
  | { status: "invalid"; problems: DirectoryImportProblem[] };

/** Separates Company groups inside the column, because commas and semicolons separate columns. */
const COMPANY_GROUP_SEPARATOR = "|";

const COLUMN_NAMES: Record<string, keyof DirectoryImportUser> = {
  email: "email",
  displayname: "displayName",
  display_name: "displayName",
  companygroups: "companyGroups",
  company_groups: "companyGroups",
  active: "active",
};

/** Excel writes UTF-8 files with a byte order mark. In some locales it separates with `;`. */
function readCsvRecords(text: string): string[][] {
  const content = text.replace(/^﻿/, "");
  const firstLine = content.split(/\r?\n/, 1)[0];
  const separator = firstLine.includes(";") && !firstLine.includes(",") ? ";" : ",";
  return parseCsv(content, { separator });
}

function readActive(value: string): boolean | string | undefined {
  const normalizedValue = value.trim().toLowerCase();
  if (normalizedValue === "") return undefined;
  if (["true", "yes", "1"].includes(normalizedValue)) return true;
  if (["false", "no", "0"].includes(normalizedValue)) return false;
  return value;
}

/** Checks every row, so that one attempt names all the problems in a file. */
export function parseDirectoryCsv(text: string): ParsedDirectoryFile {
  let records: string[][];
  try {
    records = readCsvRecords(text);
  } catch (error) {
    return { status: "invalid", problems: [{ row: 0, message: (error as Error).message }] };
  }
  const [header, ...dataRecords] = records;
  if (header === undefined) {
    return { status: "invalid", problems: [{ row: 0, message: "The file is empty." }] };
  }
  const columns = header.map((name) => COLUMN_NAMES[name.trim().toLowerCase()]);
  const unknownColumnIndex = columns.findIndex((column) => column === undefined);
  if (unknownColumnIndex !== -1) {
    return {
      status: "invalid",
      problems: [{ row: 1, message: `The column ${header[unknownColumnIndex]} is not known.` }],
    };
  }
  if (!columns.includes("email") || !columns.includes("displayName")) {
    return {
      status: "invalid",
      problems: [{ row: 1, message: "The columns email and displayName are required." }],
    };
  }
  const usedRecords = dataRecords
    .map((record, recordIndex) => ({ record, rowNumber: recordIndex + 2 }))
    .filter(({ record }) => record.some((field) => field.trim() !== ""));
  const candidates = usedRecords.map(({ record, rowNumber }) => {
    if (record.length !== columns.length) {
      return {
        rowNumber,
        problem: `The row has ${record.length} columns instead of ${columns.length}.`,
      };
    }
    const fields: Record<string, unknown> = {};
    columns.forEach((column, columnIndex) => {
      const value = record[columnIndex];
      if (column === "companyGroups") {
        fields[column] = value.split(COMPANY_GROUP_SEPARATOR).map((name) => name.trim())
          .filter((name) => name !== "");
      } else if (column === "active") {
        fields[column] = readActive(value);
      } else {
        fields[column] = value;
      }
    });
    return { rowNumber, fields };
  });
  return validateRows(candidates);
}

interface RowCandidate {
  rowNumber: number;
  fields?: unknown;
  problem?: string;
}

function validateRows(candidates: RowCandidate[]): ParsedDirectoryFile {
  if (candidates.length === 0) {
    return { status: "invalid", problems: [{ row: 0, message: "The file has no people in it." }] };
  }
  if (candidates.length > MAXIMUM_DIRECTORY_IMPORT_ROWS) {
    return {
      status: "invalid",
      problems: [{
        row: 0,
        message: `A file may have at most ${MAXIMUM_DIRECTORY_IMPORT_ROWS} people.`,
      }],
    };
  }
  const rows: DirectoryImportRow[] = [];
  const problems: DirectoryImportProblem[] = [];
  for (const { rowNumber, fields, problem } of candidates) {
    if (problem !== undefined) {
      problems.push({ row: rowNumber, message: problem });
      continue;
    }
    const parsedRow = directoryImportUserSchema.safeParse(fields);
    if (parsedRow.success) {
      rows.push({ ...parsedRow.data, rowNumber });
    } else {
      problems.push({
        row: rowNumber,
        message: parsedRow.error.issues.map((issue) =>
          `${issue.path.join(".") || "row"}: ${issue.message}`
        ).join("; "),
      });
    }
  }
  return problems.length > 0 ? { status: "invalid", problems } : { status: "parsed", rows };
}

/** The rows of a JSON file that the route has validated, numbered from 1. */
export function numberJsonRows(users: DirectoryImportUser[]): DirectoryImportRow[] {
  return users.map((user, userIndex) => ({ ...user, rowNumber: userIndex + 1 }));
}
