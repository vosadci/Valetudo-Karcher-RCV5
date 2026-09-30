import {Capability, useDuststreamingConfigurationQuery} from "api";
import {useCapabilitiesSupported} from "CapabilitiesProvider";
import {CapabilityGate, PAGE_REGISTRY, SECTIONS} from "./PageRegistry";

const GATED_CAPABILITIES: Array<Capability> = Array.from(new Set(
    [...Object.values(PAGE_REGISTRY), ...Object.values(SECTIONS)]
        .flatMap(def => def.gate?.capabilities ?? [])
));

export interface NavVisibility {
    isPageVisible: (pageKey: string) => boolean,
    isSectionVisible: (sectionKey: string) => boolean
}

export const useNavVisibility = (): NavVisibility => {
    const supportedFlags = useCapabilitiesSupported(...GATED_CAPABILITIES);
    const supported = new Set(GATED_CAPABILITIES.filter((_, i) => supportedFlags[i]));

    const {data: duststreamingConfiguration} = useDuststreamingConfigurationQuery({
        enabled: supported.has(Capability.Duststreaming)
    });
    const duststreamingEnabled = duststreamingConfiguration?.enabled === true;

    const passes = (gate: CapabilityGate | undefined): boolean => {
        if (gate === undefined) {
            return true;
        }

        return gate.type === "allof" ?
            gate.capabilities.every(c => supported.has(c)) :
            gate.capabilities.some(c => supported.has(c));
    };

    return {
        isPageVisible: (pageKey) => {
            const page = PAGE_REGISTRY[pageKey];

            return page !== undefined &&
                passes(page.gate) &&
                (page.needsDuststreamEnabled !== true || duststreamingEnabled);
        },
        isSectionVisible: (sectionKey) => {
            const section = SECTIONS[sectionKey];

            return section !== undefined &&
                passes(section.gate) &&
                (section.hub !== undefined || section.pageKeys.some(key => {
                    const page = PAGE_REGISTRY[key];

                    return passes(page.gate) && (page.needsDuststreamEnabled !== true || duststreamingEnabled);
                }));
        }
    };
};
