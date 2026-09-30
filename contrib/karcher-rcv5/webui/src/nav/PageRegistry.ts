import React from "react";
import {Capability} from "api";
import CleaningOptions from "../CleaningOptions";
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
    // Map pages size themselves to their container's height instead of scrolling with the sheet.
    layout?: "fill",
    // Camera and Spectator are additionally hidden unless duststreaming is switched on.
    needsDuststreamEnabled?: boolean
}

// Keys are the route paths Valetudo's own router uses, so the `url` props of the reused
// list-menu links can be used as keys without any translation.
export const PAGE_REGISTRY: Record<string, PageDef> = {
    // Not in any section: opened from the action bar.
    "/cleaning_options": {title: "Cleaning options", component: CleaningOptions},
    "/robot/consumables": {
        title: "Consumables",
        component: Consumables,
        gate: {type: "allof", capabilities: [Capability.ConsumableMonitoring]}
    },
    "/robot/manual_control": {
        title: "Manual control",
        component: ManualControl,
        gate: {type: "anyof", capabilities: [Capability.ManualControl, Capability.HighResolutionManualControl]}
    },
    "/robot/total_statistics": {
        title: "Statistics",
        component: TotalStatistics,
        gate: {type: "allof", capabilities: [Capability.TotalStatistics]}
    },
    "/robot/camera": {
        title: "Camera",
        component: Duststream,
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
    "/valetudo/timers": {title: "Timers", component: Timers},
    "/valetudo/log": {title: "Log", component: Log},
    "/valetudo/updater": {title: "Updater", component: Updater},
    "/valetudo/system_information": {title: "System Information", component: SystemInformation},
    "/valetudo/ai": {title: "AI Assistant", component: ValetudoAI},
    "/valetudo/help": {title: "General Help", component: Help},
    "/valetudo/about": {title: "About Valetudo", component: About},
};

export interface SectionDef {
    title: string,
    pageKeys: Array<string>,
    gate?: CapabilityGate,
    // A reused Valetudo page that is itself the section's menu, rendered instead of a flat list.
    hub?: React.ComponentType
}

export const SECTIONS: Record<string, SectionDef> = {
    robot: {
        title: "Robot",
        pageKeys: ["/robot/consumables", "/robot/manual_control", "/robot/total_statistics", "/robot/camera"],
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
    connectivity: {title: "Connectivity Options", pageKeys: [], hub: ConnectivityOptions},
    robotOptions: {title: "Robot Options", pageKeys: [], hub: RobotOptions},
    valetudoOptions: {title: "Valetudo Options", pageKeys: [], hub: ValetudoOptions},
    misc: {
        title: "Misc",
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
