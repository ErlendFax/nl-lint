import { lintSource, defaults, defaultCriteria, type Choice, type Config, type Report, type Rules } from 'nl-lint'
// Compile only: this function is never executed.
async function verifyTypes() {
  const customRules: Rules = {
    comments: 'Comments must explain intent.',
    naming: { instructions: 'Use descriptive names.' },
    state: { instructions: ['Avoid redundant state.', 'Preserve intentional snapshots.'], criteria: defaultCriteria, threshold: 0.9 },
  }
  const config: Config = {
    rules: customRules, threshold: defaults.threshold, cache: false,
    evaluate: async request => ({ model: request.model, answers: {
      comments: { type: 'choice', choice: 'insufficient_context', probabilities: { violation: 0, pass: 0, insufficient_context: 1 } },
    } }),
  }
  const report: Report = await lintSource({ ...config, file: 'example.ts', source: 'export {}' })
  const probability: number = report.results[0].probabilities.violation
  void probability
  // @ts-expect-error thresholds must be numbers
  const invalid: Config = { rules: customRules, threshold: 'high' }
  void invalid
  // @ts-expect-error custom rules remain required
  lintSource({ file: 'example.ts', source: 'export {}' })
  // @ts-expect-error object-form rules require instructions
  const emptyRule: Rules = { comments: {} }
  // @ts-expect-error display options and criteria do not replace instructions
  const missingInstructions: Rules = { comments: { title: 'Comments', criteria: defaultCriteria } }
  // @ts-expect-error criteria must describe all three outcomes
  const incomplete: Rules = { comments: { instructions: 'Comments must explain intent.', criteria: { violation: 'Bad', pass: 'Good' } } }
  // @ts-expect-error transports must return a complete response
  const invalidTransport: Config = { rules: customRules, evaluate: async () => ({ model: defaults.model }) }
  // @ts-expect-error unknown outcomes are not choices
  const invalidChoice: Choice = 'unknown'
  const choice: Choice = report.results[0].choice
  const confidence: number | undefined = report.results[0].confidence
  void [emptyRule, missingInstructions, incomplete, invalidTransport, invalidChoice, choice, confidence]
}
void verifyTypes
