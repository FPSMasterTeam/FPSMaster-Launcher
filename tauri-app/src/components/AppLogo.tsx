import launcherIcon from "../assets/launcher.png";

type AppLogoProps = {
  size?: number;
  className?: string;
};

export default function AppLogo({ size = 24, className = "" }: AppLogoProps) {
  return (
    <img
      src={launcherIcon}
      alt="FPSMaster"
      width={size}
      height={size}
      className={`block object-cover ${className}`}
      draggable={false}
    />
  );
}
