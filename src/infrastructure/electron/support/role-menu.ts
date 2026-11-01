/**
 * A menu made only of Electron's built-in roles, written as groups.
 *
 * Electron gives every role its label, accelerator and behaviour, so the only
 * thing left to say about such a menu is which roles go in it and where the
 * separators fall.
 */
import type {MenuItemConstructorOptions} from 'electron';

export type MenuRole = NonNullable<MenuItemConstructorOptions['role']>;

/** One menu's items: each group's roles in order, with a separator between groups. */
export function roleMenu(label: string, groups: readonly (readonly MenuRole[])[]): MenuItemConstructorOptions {
    const submenu = groups.flatMap((group, index): MenuItemConstructorOptions[] => [
        ...(index > 0 ? [{type: 'separator' as const}] : []),
        ...group.map((role) => ({role})),
    ]);
    return {label, submenu};
}
