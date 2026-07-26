import { inject, type InjectionKey } from "vue";
import { api, type ApiClient } from "./client.ts";

/**
 * Components reach the API through injection rather than importing the
 * singleton, so a test can mount a page with a stub client and no module
 * mocking.
 */
export const apiKey: InjectionKey<ApiClient> = Symbol("amber.api");

export function useApi(): ApiClient {
  return inject(apiKey, api);
}
