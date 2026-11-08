import type { Dataset, TestCase, TestCaseDefinition } from "@extispex/contracts";
import { type InferEntity, UniqueConstraintViolationException } from "@mikro-orm/core";
import type { EvaluationDatabase } from "./evaluation-database.ts";
import { DatasetRecord, TestCaseRecord } from "./evaluation-entities.ts";

/** A Dataset found by name within a Project, identified internally by its ID. */
export interface StoredDataset {
  id: string;
  name: string;
}

export interface NewTestCase {
  name: string;
  definition: TestCaseDefinition;
}

export type CreateResult<Created> = { status: "created"; created: Created } | {
  status: "name_taken";
};

export interface DatasetRepository {
  createDataset(
    projectId: string,
    dataset: { name: string; description: string },
    createdAt: Date,
  ): Promise<CreateResult<Dataset>>;
  listDatasets(projectId: string): Promise<Dataset[]>;
  findDataset(projectId: string, datasetName: string): Promise<StoredDataset | null>;
  readDataset(dataset: StoredDataset): Promise<Dataset>;
  deleteDataset(dataset: StoredDataset): Promise<void>;
  createTestCase(
    dataset: StoredDataset,
    testCase: NewTestCase,
    createdAt: Date,
  ): Promise<CreateResult<TestCase>>;
  /** By name. */
  listTestCases(dataset: StoredDataset): Promise<TestCase[]>;
  findTestCase(dataset: StoredDataset, testCaseName: string): Promise<TestCase | null>;
  /** Null when the Test Case does not exist. */
  updateTestCase(
    dataset: StoredDataset,
    testCaseName: string,
    definition: TestCaseDefinition,
    updatedAt: Date,
  ): Promise<TestCase | null>;
  /** False when the Test Case does not exist. */
  deleteTestCase(dataset: StoredDataset, testCaseName: string, deletedAt: Date): Promise<boolean>;
}

type DatasetRow = InferEntity<typeof DatasetRecord>;
type TestCaseRow = InferEntity<typeof TestCaseRecord>;

export function createDatasetRepository(database: EvaluationDatabase): DatasetRepository {
  const countTestCases = (datasetId: string) =>
    database.orm.em.fork().count(TestCaseRecord, { datasetId });

  const markDatasetChanged = (datasetId: string, changedAt: Date) =>
    database.orm.em.fork().nativeUpdate(DatasetRecord, { id: datasetId }, { updatedAt: changedAt });

  return {
    async createDataset(projectId, dataset, createdAt) {
      const row = {
        id: crypto.randomUUID(),
        projectId,
        name: dataset.name,
        description: dataset.description,
        createdAt,
        updatedAt: createdAt,
      };
      try {
        await database.orm.em.fork().insert(DatasetRecord, row);
      } catch (error) {
        if (error instanceof UniqueConstraintViolationException) return { status: "name_taken" };
        throw error;
      }
      return { status: "created", created: toDataset(row, 0) };
    },

    async listDatasets(projectId) {
      const datasetRows = await database.orm.em.fork().find(
        DatasetRecord,
        { projectId },
        { orderBy: { updatedAt: "desc", name: "asc" } },
      );
      const datasets: Dataset[] = [];
      for (const datasetRow of datasetRows) {
        datasets.push(toDataset(datasetRow, await countTestCases(datasetRow.id)));
      }
      return datasets;
    },

    async findDataset(projectId, datasetName) {
      const datasetRow = await database.orm.em.fork().findOne(DatasetRecord, {
        projectId,
        name: datasetName,
      });
      return datasetRow === null ? null : { id: datasetRow.id, name: datasetRow.name };
    },

    async readDataset(dataset) {
      const datasetRow = await database.orm.em.fork().findOneOrFail(DatasetRecord, {
        id: dataset.id,
      });
      return toDataset(datasetRow, await countTestCases(dataset.id));
    },

    async deleteDataset(dataset) {
      await database.orm.em.fork().nativeDelete(DatasetRecord, { id: dataset.id });
    },

    async createTestCase(dataset, testCase, createdAt) {
      const row = {
        id: crypto.randomUUID(),
        datasetId: dataset.id,
        name: testCase.name,
        definition: testCase.definition,
        createdAt,
        updatedAt: createdAt,
      };
      try {
        await database.orm.em.fork().insert(TestCaseRecord, row);
      } catch (error) {
        if (error instanceof UniqueConstraintViolationException) return { status: "name_taken" };
        throw error;
      }
      await markDatasetChanged(dataset.id, createdAt);
      return { status: "created", created: toTestCase(dataset.name, row) };
    },

    async listTestCases(dataset) {
      const testCaseRows = await database.orm.em.fork().find(
        TestCaseRecord,
        { datasetId: dataset.id },
        { orderBy: { name: "asc" } },
      );
      return testCaseRows.map((testCaseRow) => toTestCase(dataset.name, testCaseRow));
    },

    async findTestCase(dataset, testCaseName) {
      const testCaseRow = await database.orm.em.fork().findOne(TestCaseRecord, {
        datasetId: dataset.id,
        name: testCaseName,
      });
      return testCaseRow === null ? null : toTestCase(dataset.name, testCaseRow);
    },

    async updateTestCase(dataset, testCaseName, definition, updatedAt) {
      const entityManager = database.orm.em.fork();
      const changedCount = await entityManager.nativeUpdate(TestCaseRecord, {
        datasetId: dataset.id,
        name: testCaseName,
      }, { definition, updatedAt });
      if (changedCount === 0) return null;
      await markDatasetChanged(dataset.id, updatedAt);
      const testCaseRow = await entityManager.findOneOrFail(TestCaseRecord, {
        datasetId: dataset.id,
        name: testCaseName,
      });
      return toTestCase(dataset.name, testCaseRow);
    },

    async deleteTestCase(dataset, testCaseName, deletedAt) {
      const deletedCount = await database.orm.em.fork().nativeDelete(TestCaseRecord, {
        datasetId: dataset.id,
        name: testCaseName,
      });
      if (deletedCount === 0) return false;
      await markDatasetChanged(dataset.id, deletedAt);
      return true;
    },
  };
}

function toDataset(
  datasetRow: Pick<DatasetRow, "name" | "description" | "createdAt" | "updatedAt">,
  testCaseCount: number,
): Dataset {
  return {
    name: datasetRow.name,
    description: datasetRow.description,
    testCaseCount,
    createdAt: datasetRow.createdAt.toISOString(),
    updatedAt: datasetRow.updatedAt.toISOString(),
  };
}

function toTestCase(
  datasetName: string,
  testCaseRow: Pick<TestCaseRow, "name" | "definition" | "createdAt" | "updatedAt">,
): TestCase {
  return {
    ...testCaseRow.definition,
    name: testCaseRow.name,
    datasetName,
    createdAt: testCaseRow.createdAt.toISOString(),
    updatedAt: testCaseRow.updatedAt.toISOString(),
  };
}
