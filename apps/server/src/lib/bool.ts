/** Converts DB integer booleans (0/1) to JS booleans and back. */
export const toBool = (v: number | null | undefined): boolean => v === 1;
export const fromBool = (v: boolean): number => (v ? 1 : 0);
