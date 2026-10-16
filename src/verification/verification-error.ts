import { DomainException } from '../common/domain-error.js';
export function verificationError(code: string, status = 409): never {
  throw new DomainException(code, status, code);
}
