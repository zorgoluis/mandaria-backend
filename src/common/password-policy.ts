/**
 * Password policy of Mandaria human accounts, shared by the SUPER_ADMIN bootstrap and account
 * activation. Login accepts up to PASSWORD_MAX_LENGTH so no stored password is ever unusable.
 */
export const PASSWORD_MIN_LENGTH = 16;
export const PASSWORD_MAX_LENGTH = 128;
