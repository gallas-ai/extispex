/**
 * Regenerates the OTLP protobuf descriptor from the vendored `.proto` files. Run it after
 * updating the files in `src/ingestion/otlp-proto/`.
 */
import protobuf from "protobufjs";

const protoDirectory = new URL("../src/ingestion/otlp-proto/opentelemetry/proto/", import.meta.url);
const descriptorFile = new URL(
  "../src/ingestion/generated/otlp-descriptor.json",
  import.meta.url,
);

// Parsed in dependency order, because the parser does not follow imports.
const protoFilesInDependencyOrder = [
  "common/v1/common.proto",
  "resource/v1/resource.proto",
  "trace/v1/trace.proto",
  "collector/trace/v1/trace_service.proto",
  "logs/v1/logs.proto",
  "collector/logs/v1/logs_service.proto",
  "metrics/v1/metrics.proto",
  "collector/metrics/v1/metrics_service.proto",
];

const otlpRoot = new protobuf.Root();
for (const protoFile of protoFilesInDependencyOrder) {
  const protoSource = await Deno.readTextFile(new URL(protoFile, protoDirectory));
  protobuf.parse(protoSource, otlpRoot, { keepCase: false });
}
otlpRoot.resolveAll();

await Deno.mkdir(new URL(".", descriptorFile), { recursive: true });
await Deno.writeTextFile(descriptorFile, JSON.stringify(otlpRoot.toJSON(), null, 2) + "\n");
console.log(`Wrote ${descriptorFile.pathname}`);
