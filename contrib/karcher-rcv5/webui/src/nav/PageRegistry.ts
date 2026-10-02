import React from "react";
import {
    AccessTime as TimeIcon,
    Article as LogIcon,
    CleaningServices as RobotSectionIcon,
    Equalizer as StatisticsIcon,
    Help as HelpIcon,
    Hub as ConnectivityIcon,
    Info as AboutIcon,
    Layers as SavedMapsIcon,
    Map as MapManagementIcon,
    MoreHoriz as MiscIcon,
    PendingActions as PendingActionsIcon,
    SettingsRemote as SettingsRemoteIcon,
    SmartToy as AiIcon,
    SystemUpdateAlt as UpdaterIcon,
    Videocam as CameraIcon,
    Wysiwyg as SystemInformationIcon
} from "@mui/icons-material";
import {Capability} from "api";
import {RobotMonochromeIcon, ValetudoMonochromeIcon} from "components/CustomIcons";
import CameraPage from "../CameraPage";
import CleaningOptions from "../CleaningOptions";
import MapsPage from "../MapsPage";
import About from "valetudo/About";
import Analytics from "valetudo/Analytics";
import Help from "valetudo/Help";
import Log from "valetudo/Log";
import SystemInformation from "valetudo/SystemInformation";
import Timers from "valetudo/timers/Timers";
import Updater from "valetudo/Updater";
import ValetudoAI from "valetudo/ValetudoAI";
import ValetudoOptions from "options/ValetudoOptions";
import AuthSettingsPage from "options/connectivity/AuthSettingsPage";
import ConnectivityOptions from "options/connectivity/ConnectivityOptions";
import Quirks from "robot/capabilities/Quirks";
import RobotOptions from "robot/RobotOptions";
import SystemRobotOptions from "robot/capabilities/SystemRobotOptions";
import MQTTConnectivityPage from "options/connectivity/MQTTConnectivityPage";
import NetworkAdvertisementSettingsPage from "options/connectivity/NetworkAdvertisementSettingsPage";
import NTPConnectivityPage from "options/connectivity/NTPConnectivityPage";
import WifiConnectivityPage from "options/connectivity/WifiConnectivityPage";
import EditMapPage from "map/EditMapPage";
import MapManagement from "options/MapManagement";
import RobotCoverageMapPage from "map/RobotCoverageMapPage";
import SpectatorMapPage from "map/SpectatorMapPage";
import Consumables from "robot/Consumables";
import Duststream from "robot/Duststream";
import ManualControl from "robot/ManualControl";
import TotalStatistics from "robot/TotalStatistics";

// Same shape as the gates in Valetudo's own menuTree / options routers.
export interface CapabilityGate {
    type: "allof" | "anyof",
    capabilities: Array<Capability>
}

export interface PageDef {
    title: string,
    component: React.ComponentType<any>,
    props?: Record<string, unknown>,
    gate?: CapabilityGate,
    // Row icon and subtitle when the page is listed in a section menu. Icons as in Valetudo's drawer.
    icon?: React.ElementType,
    description?: string,
    // Map pages size themselves to their container's height instead of scrolling with the sheet.
    layout?: "fill",
    // Camera and Spectator are additionally hidden unless duststreaming is switched on.
    needsDuststreamEnabled?: boolean,
    // Opened from the action bar, not the menu, so the sheet has no Back button.
    standalone?: boolean
}

// Keys are the route paths Valetudo's own router uses, so the `url` props of the reused
// list-menu links can be used as keys without any translation.
export const PAGE_REGISTRY: Record<string, PageDef> = {
    // Not in any section: opened from the action bar.
    "/cleaning_options": {title: "Cleaning options", component: CleaningOptions, standalone: true},
    "/karcher/maps": {title: "Saved maps", component: MapsPage},
    "/karcher/camera": {
        title: "Camera",
        component: CameraPage,
        layout: "fill",
        icon: CameraIcon,
        description: "Live view from the robot's camera"
    },
    "/robot/consumables": {
        title: "Consumables",
        component: Consumables,
        icon: PendingActionsIcon,
        description: "Check and reset brushes, filters and other wear parts",
        gate: {type: "allof", capabilities: [Capability.ConsumableMonitoring]}
    },
    "/robot/manual_control": {
        title: "Manual control",
        component: ManualControl,
        icon: SettingsRemoteIcon,
        description: "Drive the robot by hand",
        gate: {type: "anyof", capabilities: [Capability.ManualControl, Capability.HighResolutionManualControl]}
    },
    "/robot/total_statistics": {
        title: "Statistics",
        component: TotalStatistics,
        icon: StatisticsIcon,
        description: "Totals across all cleanups",
        gate: {type: "allof", capabilities: [Capability.TotalStatistics]}
    },
    "/robot/camera": {
        title: "Camera",
        component: Duststream,
        icon: CameraIcon,
        description: "Live view from the robot's camera",
        gate: {type: "allof", capabilities: [Capability.Duststreaming]},
        needsDuststreamEnabled: true
    },
    "/options/map_management/segments": {
        title: "Room Management",
        component: EditMapPage,
        props: {mode: "segments"},
        layout: "fill",
        gate: {type: "anyof", capabilities: [Capability.MapSegmentEdit, Capability.MapSegmentRename]}
    },
    "/options/map_management/virtual_restrictions": {
        title: "Virtual Restrictions",
        component: EditMapPage,
        props: {mode: "virtual_restrictions"},
        layout: "fill",
        gate: {type: "allof", capabilities: [Capability.CombinedVirtualRestrictions]}
    },
    "/options/map_management/annotations": {
        title: "Map Annotations",
        component: EditMapPage,
        props: {mode: "annotations"},
        layout: "fill",
        gate: {type: "allof", capabilities: [Capability.MapAnnotations]}
    },
    "/options/map_management/robot_coverage": {
        title: "Robot Coverage Map",
        component: RobotCoverageMapPage,
        layout: "fill"
    },
    "/options/map_management/spectator": {
        title: "Spectator Map",
        component: SpectatorMapPage,
        layout: "fill",
        gate: {type: "allof", capabilities: [Capability.Duststreaming]},
        needsDuststreamEnabled: true
    },
    "/options/connectivity/auth": {title: "Auth Settings", component: AuthSettingsPage},
    "/options/connectivity/mqtt": {title: "MQTT Connectivity", component: MQTTConnectivityPage},
    "/options/connectivity/networkadvertisement": {title: "Network Advertisement", component: NetworkAdvertisementSettingsPage},
    "/options/connectivity/ntp": {title: "NTP Connectivity", component: NTPConnectivityPage},
    "/options/connectivity/wifi": {
        title: "Wi-Fi Connectivity",
        component: WifiConnectivityPage,
        gate: {type: "allof", capabilities: [Capability.WifiConfiguration]}
    },
    "/options/robot/system": {title: "System Options", component: SystemRobotOptions},
    "/options/robot/quirks": {
        title: "Quirks",
        component: Quirks,
        gate: {type: "allof", capabilities: [Capability.Quirks]}
    },
    "/options/valetudo/analytics": {title: "Analytics", component: Analytics},
    "/valetudo/timers": {title: "Timers", component: Timers, icon: TimeIcon, description: "Schedule cleanups"},
    "/valetudo/log": {title: "Log", component: Log, icon: LogIcon, description: "Valetudo's log messages"},
    "/valetudo/updater": {title: "Updater", component: Updater, icon: UpdaterIcon, description: "Check for and install Valetudo updates"},
    "/valetudo/system_information": {
        title: "System Information",
        component: SystemInformation,
        icon: SystemInformationIcon,
        description: "Robot, Valetudo and host details"
    },
    "/valetudo/ai": {title: "AI Assistant", component: ValetudoAI, icon: AiIcon, description: "Ask questions about Valetudo"},
    "/valetudo/help": {title: "General Help", component: Help, icon: HelpIcon, description: "How Valetudo works"},
    "/valetudo/about": {title: "About Valetudo", component: About, icon: AboutIcon, description: "Version, license and credits"},
};

export interface SectionDef {
    title: string,
    icon: React.ElementType,
    // Subtitle of the section's own menu, as Valetudo's hub pages have
    description?: string,
    pageKeys: Array<string>,
    gate?: CapabilityGate,
    // A reused Valetudo page that is itself the section's menu, rendered instead of a flat list.
    hub?: React.ComponentType,
    // A section with a single page opens that page directly, with no one-row menu in between.
    page?: string
}

export const SECTIONS: Record<string, SectionDef> = {
    robot: {
        title: "Robot",
        icon: RobotSectionIcon,
        description: "Wear parts, statistics and other robot pages",
        pageKeys: ["/robot/consumables", "/robot/manual_control", "/robot/total_statistics", "/robot/camera", "/karcher/camera"],
        gate: {
            type: "anyof",
            capabilities: [
                Capability.ConsumableMonitoring,
                Capability.ManualControl,
                Capability.HighResolutionManualControl,
                Capability.TotalStatistics,
                Capability.Duststreaming
            ]
        }
    },
    map: {
        title: "Map Options",
        icon: MapManagementIcon,
        pageKeys: [],
        hub: MapManagement,
        gate: {
            type: "anyof",
            capabilities: [
                Capability.PersistentMapControl,
                Capability.MappingPass,
                Capability.MapReset,
                Capability.MapSegmentEdit,
                Capability.MapSegmentRename,
                Capability.CombinedVirtualRestrictions,
                Capability.MapAnnotations
            ]
        }
    },
    savedMaps: {title: "Saved maps", icon: SavedMapsIcon, pageKeys: ["/karcher/maps"], page: "/karcher/maps"},
    connectivity: {title: "Connectivity Options", icon: ConnectivityIcon, pageKeys: [], hub: ConnectivityOptions},
    robotOptions: {title: "Robot Options", icon: RobotMonochromeIcon, pageKeys: [], hub: RobotOptions},
    valetudoOptions: {title: "Valetudo Options", icon: ValetudoMonochromeIcon, pageKeys: [], hub: ValetudoOptions},
    misc: {
        title: "Misc",
        icon: MiscIcon,
        description: "Timers, log, updates and help",
        pageKeys: [
            "/valetudo/timers",
            "/valetudo/log",
            "/valetudo/updater",
            "/valetudo/system_information",
            "/valetudo/ai",
            "/valetudo/help",
            "/valetudo/about"
        ]
    },
};
