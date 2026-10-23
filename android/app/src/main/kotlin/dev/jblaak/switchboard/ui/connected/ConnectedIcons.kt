package dev.jblaak.switchboard.ui.connected

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/* The line icons from the design: 24-unit grid, round caps and joins, tinted by the Icon drawing them. */

val BackIcon: ImageVector by lazy { lineIcon("Back", "M19 12H5", "M11 6l-6 6 6 6") }
val CloseIcon: ImageVector by lazy { lineIcon("Close", "M6 6l12 12M18 6L6 18") }
val MoreIcon: ImageVector by lazy {
    lineIcon(
        "More",
        "M12 3.8a1.2 1.2 0 1 1 0 2.4a1.2 1.2 0 1 1 0-2.4z",
        "M12 10.8a1.2 1.2 0 1 1 0 2.4a1.2 1.2 0 1 1 0-2.4z",
        "M12 17.8a1.2 1.2 0 1 1 0 2.4a1.2 1.2 0 1 1 0-2.4z",
    )
}
val SendIcon: ImageVector by lazy { lineIcon("Send", "M12 19V5", "M5 12l7-7 7 7") }
val AddIcon: ImageVector by lazy { lineIcon("Add", "M12 5v14M5 12h14") }
val UpIcon: ImageVector by lazy { lineIcon("Up", "M12 19V5", "M6 11l6-6 6 6") }
val DownIcon: ImageVector by lazy { lineIcon("Down", "M12 5v14", "M6 13l6 6 6-6") }
val EnterIcon: ImageVector by lazy { lineIcon("Enter", "M20 5v7a3 3 0 0 1-3 3H5", "M9 11l-4 4 4 4") }
val CheckIcon: ImageVector by lazy { lineIcon("Check", "M5 12.5l4.5 4.5L19 7.5") }
val SearchIcon: ImageVector by lazy { lineIcon("Search", "M17.5 11a6.5 6.5 0 1 1-13 0a6.5 6.5 0 1 1 13 0z", "M20 20l-4-4") }
val MicIcon: ImageVector by lazy {
    lineIcon("Mic", "M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z", "M5 11a7 7 0 0 0 14 0", "M12 18v3")
}
val PhoneIcon: ImageVector by lazy {
    lineIcon("Phone", "M9 2h6a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z", "M11 18h2")
}
val LaptopIcon: ImageVector by lazy {
    lineIcon(
        "Laptop",
        "M5.5 5h13a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 14.5v-8A1.5 1.5 0 0 1 5.5 5z",
        "M2 19h20",
    )
}
val LaptopTerminalIcon: ImageVector by lazy {
    lineIcon(
        "LaptopTerminal",
        "M5.5 5h13a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 14.5v-8A1.5 1.5 0 0 1 5.5 5z",
        "M2 19h20",
        "M8 9.5h3",
        "M8 12h6",
    )
}

private fun lineIcon(name: String, vararg paths: String): ImageVector {
    val builder = ImageVector.Builder(
        name = name,
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
    )
    for (path in paths) {
        builder.addPath(
            pathData = addPathNodes(path),
            stroke = SolidColor(Color.Black),
            strokeLineWidth = 1.8f,
            strokeLineCap = StrokeCap.Round,
            strokeLineJoin = StrokeJoin.Round,
        )
    }
    return builder.build()
}
