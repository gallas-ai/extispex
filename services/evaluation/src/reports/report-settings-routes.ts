import {
  createErrorResponse,
  getReportSettingsRoute,
  updateReportSettingsRoute,
} from "@extispex/contracts";
import type { ProjectAccessEnvironment } from "@extispex/service-runtime";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { ReportSettingsRepository } from "../storage/mod.ts";

export interface ReportSettingsRouteDependencies {
  reportSettingsRepository: ReportSettingsRepository;
  readCurrentTime: () => Date;
}

export function registerReportSettingsRoutes(
  app: OpenAPIHono<ProjectAccessEnvironment>,
  { reportSettingsRepository, readCurrentTime }: ReportSettingsRouteDependencies,
): void {
  app.openapi(getReportSettingsRoute, async (context) => {
    const settings = await reportSettingsRepository.readSettings(
      context.get("projectAccess").projectId,
    );
    return context.json(settings, 200);
  });

  app.openapi(updateReportSettingsRoute, async (context) => {
    const result = await reportSettingsRepository.saveSettings(
      context.get("projectAccess").projectId,
      context.req.valid("json"),
      readCurrentTime(),
    );
    if (result.status === "invalid") {
      return context.json(createErrorResponse("invalid_request", result.message), 400);
    }
    return context.json(result.settings, 200);
  });
}
