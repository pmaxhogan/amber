/**
 * Small DOM helpers for the component tests.
 *
 * Buttons are found by their visible label rather than a test id: the label is
 * what a user reads, so a test that breaks when the label changes is telling
 * the truth about the change.
 */

interface ElementWrapper {
  text: () => string;
  trigger: (event: string) => Promise<void>;
  attributes: () => Record<string, string>;
}

interface Searchable {
  findAll: (selector: string) => ElementWrapper[];
}

export function findByText(
  wrapper: Searchable,
  selector: string,
  label: string,
): ElementWrapper | undefined {
  return wrapper.findAll(selector).find((element) => element.text().trim() === label);
}

export function findButton(wrapper: Searchable, label: string): ElementWrapper | undefined {
  return findByText(wrapper, "button", label);
}

export async function clickButton(wrapper: Searchable, label: string): Promise<void> {
  const button = findButton(wrapper, label);
  if (button === undefined) {
    const available = wrapper
      .findAll("button")
      .map((element) => element.text().trim())
      .filter((text) => text !== "");
    throw new Error(`No button labelled "${label}". Found: ${available.join(", ")}`);
  }
  await button.trigger("click");
}

/** Let queued microtasks and the resulting render settle. */
export async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
