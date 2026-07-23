import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Merge conditional class names and resolve Tailwind class conflicts.
 * Standard shadcn/ui utility — used by every ui/* primitive.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
