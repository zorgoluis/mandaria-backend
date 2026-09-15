// Explicit, manual Google Routes integration check (development only). Not part of unit/E2E suites.
// Usage: set GOOGLE_ROUTES_API_KEY in .env, then `npm run routing:check-google`.
// Performs ONE billable computeRoutes call between two points in Ocozocoautla and prints only
// distance, duration and latency. The API key is never printed.
import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { validateEnvironment } from '../src/config/environment.js';
import { GoogleRoutingProvider } from '../src/routing/google-routing.provider.js';
import { RoutingError } from '../src/routing/routing.types.js';

try {
  const env = validateEnvironment(process.env);
  if (!env.GOOGLE_ROUTES_API_KEY) {
    console.error('GOOGLE_ROUTES_API_KEY is not set; nothing was called.');
    process.exitCode = 2;
  } else {
    const provider = new GoogleRoutingProvider(new ConfigService(env));
    const started = Date.now();
    const route = await provider.calculateRoute(
      { latitude: 16.755, longitude: -93.39 },
      { latitude: 16.775, longitude: -93.365 },
    );
    console.log(
      JSON.stringify({
        result: 'PASS',
        routingProvider: route.routingProvider,
        distanceMeters: route.distanceMeters,
        durationSeconds: route.durationSeconds,
        latencyMs: Date.now() - started,
        travelMode: env.GOOGLE_ROUTES_TRAVEL_MODE,
      }),
    );
  }
} catch (error) {
  console.error(
    JSON.stringify({
      result: 'FAIL',
      code: error instanceof RoutingError ? error.code : 'CONFIGURATION',
      reason:
        error instanceof RoutingError ? error.reason : 'Invalid environment',
    }),
  );
  process.exitCode = 1;
}
