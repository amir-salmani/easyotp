// Test-only keypair for the Host-to-Receiver interop fixture. Valid nowhere
// else. The Host's unit test seals to the public half and interop.spec.ts opens
// with the private half, so a change to either side's sealing fails in CI.
export const INTEROP_PRIVATE_KEY = "oM36R01IPG6RZUUybmE_TX_G7E6m5mfLCeeSvuU9pn0";
export const INTEROP_PUBLIC_KEY = "cPBUlcXX9VZOze4ZSgxhSk3rUs3a1w92okcGQO2Xk04";
