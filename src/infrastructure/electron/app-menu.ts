/**
 * The application menu.
 *
 * Switchboard's own commands all live in the window, so the menu holds nothing
 * but Electron's roles. It still has to exist: on macOS copy, paste, undo and
 * the window shortcuts are accelerators of menu items, and an app without a
 * menu has none of them.
 */
import {app, Menu} from 'electron';
import {roleMenu} from './support/role-menu';

export function buildApplicationMenu(): void {
    const menus = [
        roleMenu(app.name, [['about'], ['hide', 'hideOthers', 'unhide'], ['quit']]),
        roleMenu('Edit', [
            ['undo', 'redo'],
            ['cut', 'copy', 'paste', 'selectAll'],
        ]),
        roleMenu('View', [['toggleDevTools'], ['resetZoom', 'zoomIn', 'zoomOut'], ['togglefullscreen']]),
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(menus));
}
